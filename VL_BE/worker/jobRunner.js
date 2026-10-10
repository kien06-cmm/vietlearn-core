// Chức năng: chạy job từ hàng đợi theo job.type (hiện có "extract_document": tải file -> trích văn bản -> chunk -> ghi Firestore); có tiến độ, retry (backoff), dead-letter.
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getDb } from '../firebase.js';
import { downloadFile, removeFiles } from '../storage.js';
import { getPlan } from '../config/plans.js';
import { captureError } from '../monitoring.js';
import { extractPages, UserError } from './extract.js';
import { buildChunks } from './text.js';
import { settleFailure } from './failure.js';
import { processGenerateQuestions } from './generateQuestions.js';
import { processGeneratePractice } from './generatePractice.js';
import { selectReady } from './queueRules.js';

const NOT_FOUND = 5; // mã lỗi gRPC khi document không còn tồn tại
const PROGRESS_EVERY = 5; // ghi tiến độ mỗi 5 trang (tiết kiệm lượt ghi Firestore)
const BATCH_SIZE = 400; // Firestore giới hạn 500 thao tác / batch
const STALE_MS = 10 * 60_000; // job "running" quá 10 phút không cập nhật => worker đã chết
const STALE_UPLOAD_MS = 24 * 60 * 60_000; // tài liệu kẹt ở "uploading" quá 24 giờ => dọn

const db = () => getDb();
const jobsCol = () => db().collection('jobs');
const docsCol = () => db().collection('documents');

// Tài liệu bị xóa khi job đang chạy
class Cancelled extends Error {}

const isNotFound = (err) => err?.code === NOT_FOUND;

function log(level, message, extra = {}) {
    console.log(JSON.stringify({ time: new Date().toISOString(), level, scope: 'worker', message, ...extra }));
}

// Lấy 1 job sẵn sàng chạy và "giữ chỗ" bằng transaction (2 worker không lấy trùng một job)
// excludeTypes: loại job tạm thời không nhận (vd job dùng Gemini khi hệ thống đang tạm nghỉ vì 429)
export async function claimNextJob({ excludeTypes = [] } = {}) {
    // Khi loại bớt job AI, đọc nhiều hơn để job không dùng AI (vd trích văn bản) không bị che khuất phía sau
    const snap = await jobsCol().where('status', '==', 'queued').limit(excludeTypes.length ? 100 : 20).get();
    const now = Date.now() + 5000; // dung sai lệch đồng hồ giữa server và Firestore
    const ready = selectReady(snap.docs, now, excludeTypes);

    for (const d of ready) {
        const claimed = await db().runTransaction(async (tx) => {
            const s = await tx.get(d.ref);
            if (!s.exists || s.data().status !== 'queued') return null;
            const attempts = (s.data().attempts || 0) + 1;
            tx.update(d.ref, { status: 'running', attempts, updatedAt: FieldValue.serverTimestamp() });
            return { id: d.id, ...s.data(), attempts };
        });
        if (claimed) return claimed;
    }
    return null;
}

// Job "running" bị bỏ dở (server restart/crash) => đưa về hàng đợi hoặc dead-letter
export async function recoverStaleJobs() {
    const snap = await jobsCol().where('status', '==', 'running').get();
    const cutoff = Date.now() - STALE_MS;
    for (const d of snap.docs) {
        const job = d.data();
        if ((job.updatedAt?.toMillis?.() ?? 0) > cutoff) continue;
        log('warn', 'Khôi phục job bị bỏ dở', { jobId: d.id });
        await settleFailure({ id: d.id, ...job }, new Error('Worker dừng giữa chừng'));
    }
}

// Người dùng tạo tài liệu nhưng không bao giờ bấm xác nhận (tắt trình duyệt, mất mạng) => xóa file lở và trả lại hạn mức
export async function cleanupStaleUploads() {
    const snap = await docsCol().where('status', '==', 'uploading').limit(50).get();
    const cutoff = Date.now() - STALE_UPLOAD_MS;
    for (const d of snap.docs) {
        const data = d.data();
        if ((data.createdAt?.toMillis?.() ?? Date.now()) > cutoff) continue;
        await removeFiles([data.storagePath]).catch(() => {});
        await d.ref.delete();
        log('info', 'Dọn tài liệu kẹt ở bước tải lên', { documentId: d.id });
    }
}

async function writeProgress(docRef, jobRef, done, total) {
    const progress = { done, total };
    try {
        await Promise.all([
            docRef.update({ progress, updatedAt: FieldValue.serverTimestamp() }),
            jobRef.update({ progress, updatedAt: FieldValue.serverTimestamp() })
        ]);
    } catch (err) {
        if (isNotFound(err)) throw new Cancelled();
        throw err;
    }
}

async function writeChunks(docRef, chunks) {
    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
        const batch = db().batch();
        for (const c of chunks.slice(i, i + BATCH_SIZE)) {
            batch.set(docRef.collection('chunks').doc(c.id), {
                pageNumber: c.pageNumber,
                index: c.index,
                text: c.text
            });
        }
        await batch.commit();
    }
}

// Job: extract_document
async function processExtractDocument(job) {
    const jobRef = jobsCol().doc(job.id);
    const docRef = docsCol().doc(job.documentId);

    const docSnap = await docRef.get();
    if (!docSnap.exists) {
        await jobRef.delete(); // tài liệu đã bị xóa
        return;
    }
    const d = docSnap.data();

    try {
        await docRef.update({
            status: 'processing',
            error: null,
            progress: { done: 0, total: null },
            updatedAt: FieldValue.serverTimestamp()
        });

        const owner = await db().collection('users').doc(d.ownerId).get();
        const plan = getPlan(owner.data()?.plan);
        const buffer = await downloadFile(d.storagePath);

        let lastWritten = -1;
        let totalSeen = null;
        const onProgress = async (done, total) => {
            totalSeen = total;
            if (done !== 0 && done !== total && done - lastWritten < PROGRESS_EVERY) return;
            lastWritten = done;
            await writeProgress(docRef, jobRef, done, total);
        };

        const pages = await extractPages(d.ext, buffer, { maxPages: plan.maxPages, onProgress });
        const chunks = buildChunks(pages);
        await writeChunks(docRef, chunks);

        const pageCount = totalSeen ?? pages.length;
        try {
            await docRef.update({
                status: 'ready',
                pageCount,
                chunkCount: chunks.length,
                progress: { done: pageCount, total: pageCount },
                error: null,
                updatedAt: FieldValue.serverTimestamp()
            });
        } catch (err) {
            if (isNotFound(err)) throw new Cancelled();
            throw err;
        }
        await jobRef.update({
            status: 'done',
            progress: { done: pageCount, total: pageCount },
            error: null,
            updatedAt: FieldValue.serverTimestamp()
        });
        log('info', 'Xử lý xong tài liệu', { jobId: job.id, documentId: job.documentId, pages: pageCount, chunks: chunks.length });
    } catch (err) {
        if (err instanceof Cancelled || isNotFound(err)) {
            // Tài liệu bị xóa giữa chừng: dọn chunk đã lỡ ghi và bỏ job
            await db().recursiveDelete(docRef.collection('chunks')).catch(() => {});
            await jobRef.delete().catch(() => {});
            log('info', 'Tài liệu đã bị xóa khi đang xử lý', { jobId: job.id });
            return;
        }
        if (!(err instanceof UserError)) {
            captureError(err, { jobId: job.id, documentId: job.documentId });
        }
        log('error', 'Job lỗi', { jobId: job.id, attempts: job.attempts, error: err.message });
        await settleFailure(job, err);
    }
}

// Bảng điều phối: thêm loại job mới (vd generate_questions) bằng cách thêm một dòng ở đây
const HANDLERS = {
    extract_document: processExtractDocument,
    generate_questions: processGenerateQuestions,
    generate_practice: processGeneratePractice
};

export async function processJob(job) {
    const handler = HANDLERS[job.type];
    if (!handler) {
        log('error', 'Loại job không hỗ trợ', { jobId: job.id, type: job.type });
        await jobsCol()
            .doc(job.id)
            .update({
                status: 'failed',
                error: `Loại job không hỗ trợ: ${job.type}`,
                deadLetter: true,
                updatedAt: FieldValue.serverTimestamp()
            });
        return;
    }
    try {
        await handler(job);
    } catch (err) {
        // extract_document tự bắt lỗi bên trong; các loại job khác (vd generate_questions) ném lỗi lên đây
        if (!(err instanceof UserError)) captureError(err, { jobId: job.id, type: job.type });
        log('error', 'Job lỗi', { jobId: job.id, type: job.type, attempts: job.attempts, error: err.message });
        await settleFailure(job, err);
    }
}

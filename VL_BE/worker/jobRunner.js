// Chức năng: xử lý một job "extract_document": tải file -> trích văn bản -> chunk -> ghi Firestore; có tiến độ, retry (backoff), dead-letter.
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getDb } from '../firebase.js';
import { downloadFile, removeFiles } from '../storage.js';
import { getPlan } from '../config/plans.js';
import { captureError } from '../monitoring.js';
import { extractPages, UserError } from './extract.js';
import { buildChunks } from './text.js';

const NOT_FOUND = 5; // mã lỗi gRPC khi document không còn tồn tại
const PROGRESS_EVERY = 5; // ghi tiến độ mỗi 5 trang (tiết kiệm lượt ghi Firestore)
const BATCH_SIZE = 400; // Firestore giới hạn 500 thao tác / batch
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 10 * 60_000;
const STALE_MS = 10 * 60_000; // job "running" quá 10 phút không cập nhật => worker đã chết
const STALE_UPLOAD_MS = 24 * 60 * 60_000; // tài liệu kẹt ở "uploading" quá 24 giờ => dọn

const db = () => getDb();
const jobsCol = () => db().collection('jobs');
const docsCol = () => db().collection('documents');

// Tài liệu bị xóa khi job đang chạy
class Cancelled extends Error {}

const isNotFound = (err) => err?.code === NOT_FOUND;
const backoffMs = (attempts) => Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);

function log(level, message, extra = {}) {
    console.log(JSON.stringify({ time: new Date().toISOString(), level, scope: 'worker', message, ...extra }));
}

// Lấy 1 job sẵn sàng chạy và "giữ chỗ" bằng transaction (2 worker không lấy trùng một job)
export async function claimNextJob() {
    const snap = await jobsCol().where('status', '==', 'queued').limit(20).get();
    const now = Date.now() + 5000; // dung sai lệch đồng hồ giữa server và Firestore
    const ready = snap.docs
        .filter((d) => (d.data().runAfter?.toMillis?.() ?? 0) <= now)
        .sort((a, b) => a.data().runAfter.toMillis() - b.data().runAfter.toMillis());

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

// Lỗi tạm thời: retry có backoff; hết lượt thì dead-letter. Lỗi do người dùng (UserError): thất bại ngay.
async function settleFailure(job, err) {
    const jobRef = jobsCol().doc(job.id);
    const docRef = docsCol().doc(job.documentId);
    const attempts = job.attempts || 1;
    const maxAttempts = job.maxAttempts || 3;

    let jobUpdate;
    let docUpdate;

    if (err instanceof UserError) {
        jobUpdate = { status: 'failed', error: err.message, deadLetter: false };
        docUpdate = { status: 'failed', error: err.message };
    } else if (attempts >= maxAttempts) {
        jobUpdate = { status: 'failed', error: String(err.message).slice(0, 300), deadLetter: true };
        docUpdate = { status: 'failed', error: 'Xử lý thất bại, vui lòng thử lại sau' };
    } else {
        jobUpdate = {
            status: 'queued',
            error: String(err.message).slice(0, 300),
            runAfter: Timestamp.fromMillis(Date.now() + backoffMs(attempts))
        };
        docUpdate = { status: 'queued', error: null };
    }

    await jobRef.update({ ...jobUpdate, updatedAt: FieldValue.serverTimestamp() });
    await docRef.update({ ...docUpdate, updatedAt: FieldValue.serverTimestamp() }).catch((e) => {
        if (!isNotFound(e)) throw e;
    });
}

export async function processJob(job) {
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

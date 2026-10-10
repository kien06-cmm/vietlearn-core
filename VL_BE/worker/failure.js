// Chức năng: xử lý một lần job thất bại - giải phóng credits của lần chạy đó, quyết định thử lại hay thất bại hẳn, ghi lỗi lên job và tài liệu.
// Tách khỏi jobRunner.js để test được độc lập.
import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { getDb } from '../firebase.js';
import { attemptKey, settleCredits } from '../credits.js';
import { retryDelayMs, isTransient, shouldRetry } from './retryPolicy.js';
import { AI_JOB_TYPES } from './queueRules.js';

const NOT_FOUND = 5; // mã lỗi gRPC khi document không còn tồn tại
// Các loại job dùng AI credits: giữ chỗ khi bắt đầu chạy, chốt khi xong, giải phóng khi thất bại
const CREDIT_JOB_TYPES = AI_JOB_TYPES;

const isNotFound = (err) => err?.code === NOT_FOUND;

function log(level, message, extra = {}) {
    console.log(JSON.stringify({ time: new Date().toISOString(), level, scope: 'worker', message, ...extra }));
}

// Lỗi tạm thời: xếp lại hàng sau backoff nếu còn lượt. Hết lượt hoặc lỗi không thử lại: thất bại hẳn.
// Mọi lần thất bại đều giải phóng credits đã giữ chỗ của lần chạy đó (idempotent: không có gì để giải phóng thì bỏ qua).
// Ghi nhận lỗi: lastError (lần gần nhất) và failures (tổng số lần thất bại) trên job.
export async function settleFailure(job, err) {
    const db = getDb();
    const jobRef = db.collection('jobs').doc(job.id);
    const attempts = job.attempts || 1;
    const maxAttempts = job.maxAttempts || 3;
    const affectsDocument = job.type === 'extract_document' && !!job.documentId;

    if (CREDIT_JOB_TYPES.includes(job.type)) {
        await settleCredits({ uid: job.ownerId, jobId: attemptKey(job), actual: 0 });
    }

    const message = String(err?.message ?? err).slice(0, 300);
    const record = {
        failures: FieldValue.increment(1),
        lastError: { code: err?.code ?? null, message, attempt: attempts, at: FieldValue.serverTimestamp() }
    };

    let jobUpdate;
    let docUpdate;

    if (err?.userFacing) {
        // Lỗi do file/gói của người dùng: hiện nguyên message, không thử lại
        jobUpdate = { status: 'failed', error: err.message, deadLetter: false };
        docUpdate = { status: 'failed', error: err.message };
    } else if (shouldRetry(err, attempts, maxAttempts)) {
        log('warn', 'Lỗi tạm thời, sẽ thử lại', { jobId: job.id, attempts, maxAttempts, code: err?.code ?? null });
        jobUpdate = {
            status: 'queued',
            error: message,
            runAfter: Timestamp.fromMillis(Date.now() + retryDelayMs(attempts, err))
        };
        docUpdate = { status: 'queued', error: null };
    } else {
        const exhausted = isTransient(err); // lỗi tạm thời nhưng đã hết lượt => dead-letter
        const isAi = typeof err?.code === 'string' && err.code.startsWith('ai-');
        log('error', 'Job thất bại không thể thử lại', { jobId: job.id, attempts, exhausted, code: err?.code ?? null, error: message });
        jobUpdate = { status: 'failed', error: message, deadLetter: exhausted };
        docUpdate = { status: 'failed', error: isAi ? 'AI không xử lý được nội dung này' : 'Xử lý thất bại, vui lòng thử lại sau' };
    }

    await jobRef.update({ ...jobUpdate, ...record, updatedAt: FieldValue.serverTimestamp() });

    if (!affectsDocument) return;

    await db
        .collection('documents')
        .doc(job.documentId)
        .update({ ...docUpdate, updatedAt: FieldValue.serverTimestamp() })
        .catch((e) => {
            if (!isNotFound(e)) throw e;
        });
}

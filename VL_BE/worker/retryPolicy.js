// Chức năng: quyết định lỗi nào được tự thử lại và thời gian chờ giữa các lần thử (hàm thuần, dễ test).
// Chỉ thử lại lỗi TẠM THỜI: AI 429/5xx/mạng/timeout/JSON hỏng, lỗi Firestore tạm thời. Lỗi do người dùng hoặc lỗi
// không thể thử lại (nội dung bị chặn, thiếu key, file hỏng...) thất bại ngay.
export const MAX_ATTEMPTS_DEFAULT = 3;

// Mã gRPC tạm thời của Firestore: DEADLINE_EXCEEDED (4), RESOURCE_EXHAUSTED (8), UNAVAILABLE (14), ABORTED (10)
const TRANSIENT_GRPC = new Set([4, 8, 10, 14]);
// Mã lỗi mạng tạm thời (Storage, AI, Firestore khi mạng chập chờn)
const TRANSIENT_NET = new Set(['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'EPIPE']);

export function isTransient(err) {
    if (!err) return false;
    if (err.userFacing) return false; // UserError: lỗi do file/gói của người dùng
    if (err.retryable === true) return true; // AIError đánh dấu tạm thời
    if (err.retryable === false) return false; // AIError đánh dấu không thử lại
    return TRANSIENT_GRPC.has(err.code) || TRANSIENT_NET.has(err.code);
}

export const BACKOFF_BASE_MS = 30_000;
export const BACKOFF_MAX_MS = 10 * 60_000;
export const backoffMs = (attempts) => Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);

// Gemini yêu cầu chờ bao lâu (Retry-After / RetryInfo) thì chờ ít nhất bấy lâu; không chờ quá 30 phút
export const RETRY_AFTER_MAX_MS = 30 * 60_000;
export function retryDelayMs(attempts, err) {
    const hinted = Math.min(Math.max(Number(err?.retryAfterMs) || 0, 0), RETRY_AFTER_MAX_MS);
    return Math.max(backoffMs(attempts), hinted);
}

// Có nên xếp lại hàng để thử tiếp không
export function shouldRetry(err, attempts, maxAttempts = MAX_ATTEMPTS_DEFAULT) {
    return isTransient(err) && attempts < maxAttempts;
}

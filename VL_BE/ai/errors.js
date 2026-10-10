// Chức năng: lớp lỗi dùng chung cho mọi lời gọi AI (tách riêng để provider.js, cooldown.js và quotaError.js dùng chung mà không import vòng).
// retryable=true: lỗi tạm thời (429, 5xx, mạng) nên thử lại.
// retryAfterMs: thời gian nhà cung cấp AI yêu cầu chờ (header Retry-After / RetryInfo). null = không có gợi ý.
export class AIError extends Error {
    constructor(message, { retryable = false, code = 'ai-error', retryAfterMs = null } = {}) {
        super(message);
        this.retryable = retryable;
        this.code = code;
        this.retryAfterMs = retryAfterMs;
    }
}

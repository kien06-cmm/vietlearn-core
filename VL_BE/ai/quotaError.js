// Chức năng: đọc lỗi HTTP của Gemini - lấy thời gian phải chờ (header Retry-After, RetryInfo) và phân biệt
// "vượt tốc độ theo phút" (chờ rồi thử lại được) với "hết quota trong ngày" (thử lại ngay vô ích). Hàm thuần, dễ test.
import { DAILY_COOLDOWN_MS } from './cooldown.js';
import { AIError } from './errors.js';

// Retry-After: số giây ("30") hoặc ngày giờ HTTP. Trả số mili giây, hoặc null nếu không có/không hiểu.
export function parseRetryAfterHeader(value, now = Date.now()) {
    if (value === null || value === undefined || value === '') return null;
    const s = String(value).trim();
    if (/^\d+(\.\d+)?$/.test(s)) return Math.round(Number(s) * 1000);
    const t = Date.parse(s);
    return Number.isFinite(t) ? Math.max(0, t - now) : null;
}

// "34s" / "34.5s" (định dạng thời lượng của Google) -> mili giây
function parseDuration(value) {
    const m = String(value ?? '').match(/^(\d+(?:\.\d+)?)s$/);
    return m ? Math.round(Number(m[1]) * 1000) : null;
}

// Đọc thân lỗi 429 của Google: { retryAfterMs, daily }. daily=true khi quota bị vượt là quota theo NGÀY.
export function parseQuotaError({ retryAfterHeader, bodyText, now = Date.now() }) {
    let retryAfterMs = parseRetryAfterHeader(retryAfterHeader, now);
    let daily = false;
    try {
        const details = JSON.parse(bodyText)?.error?.details;
        for (const d of Array.isArray(details) ? details : []) {
            const type = String(d?.['@type'] ?? '');
            if (type.endsWith('RetryInfo') && retryAfterMs === null) retryAfterMs = parseDuration(d.retryDelay);
            if (type.endsWith('QuotaFailure')) {
                for (const v of Array.isArray(d.violations) ? d.violations : []) {
                    if (/PerDay/i.test(String(v?.quotaId ?? ''))) daily = true;
                }
            }
        }
    } catch {
        // thân lỗi không phải JSON: bỏ qua, chỉ dùng header
    }
    return { retryAfterMs, daily };
}

// Đổi phản hồi HTTP lỗi thành AIError có mã rõ ràng:
// 429 theo ngày -> ai-quota-daily (không thử lại); 429 khác -> ai-rate-limit (thử lại sau khi chờ); 5xx -> ai-http (thử lại); còn lại không thử lại.
export function httpErrorFor(status, retryAfterHeader, rawBody, now = Date.now()) {
    const detail = String(rawBody ?? '').slice(0, 300);
    if (status === 429) {
        const q = parseQuotaError({ retryAfterHeader, bodyText: rawBody, now });
        if (q.daily) {
            return new AIError('Gemini đã hết hạn mức trong ngày', { code: 'ai-quota-daily', retryAfterMs: q.retryAfterMs ?? DAILY_COOLDOWN_MS });
        }
        return new AIError(`AI lỗi 429: ${detail}`, { retryable: true, code: 'ai-rate-limit', retryAfterMs: q.retryAfterMs });
    }
    return new AIError(`AI lỗi ${status}: ${detail}`, {
        retryable: status >= 500,
        code: 'ai-http',
        retryAfterMs: parseRetryAfterHeader(retryAfterHeader, now)
    });
}

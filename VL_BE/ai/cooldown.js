// Chức năng: "tạm nghỉ toàn cục" (cooldown) khi Gemini báo 429 / hết quota.
// Khi đang tạm nghỉ, mọi lời gọi AI trong tiến trình này thất bại ngay (không gửi thêm request lên Gemini),
// và worker không nhận job dùng AI. Hết thời gian nghỉ thì tự gọi lại bình thường.
// Trạng thái nằm trong bộ nhớ của MỘT tiến trình: nếu chạy nhiều instance thì mỗi instance tự nghỉ riêng.
import { AIError } from './errors.js';

export const RATE_LIMIT_COOLDOWN_MS = 60_000; // 429 không kèm gợi ý: nghỉ 1 phút (hạn mức theo phút)
export const DAILY_COOLDOWN_MS = 30 * 60_000; // hết quota ngày: nghỉ 30 phút rồi thử lại
export const MAX_COOLDOWN_MS = 30 * 60_000; // trần: không nghỉ lâu hơn 30 phút dù Gemini gợi ý bao nhiêu

export function createCooldown(now = () => Date.now()) {
    let until = 0;
    return {
        // Bắt đầu (hoặc kéo dài) thời gian nghỉ. Không bao giờ rút ngắn thời gian nghỉ đang chạy.
        start(ms) {
            const clamped = Math.min(Math.max(Number(ms) || 0, 0), MAX_COOLDOWN_MS);
            until = Math.max(until, now() + clamped);
            return until;
        },
        remainingMs() {
            return Math.max(0, until - now());
        },
        reset() {
            until = 0;
        }
    };
}

export const aiCooldown = createCooldown();

// Lỗi trả về khi đang tạm nghỉ (retryable: job sẽ được xếp lại sau khi hết nghỉ)
export const cooldownError = (ms) =>
    new AIError('Gemini đang tạm nghỉ do vượt hạn mức, vui lòng thử lại sau', { retryable: true, code: 'ai-cooldown', retryAfterMs: ms });

// Lỗi nào làm hệ thống phải tạm nghỉ, và nghỉ bao lâu (null = không cần nghỉ)
export function cooldownMsFor(err) {
    if (err?.code === 'ai-quota-daily') return err.retryAfterMs ?? DAILY_COOLDOWN_MS;
    if (err?.code === 'ai-rate-limit') return err.retryAfterMs ?? RATE_LIMIT_COOLDOWN_MS;
    return null;
}

// Chức năng: giới hạn số request theo IP (chống spam/brute-force), lưu trong bộ nhớ của 1 server.
// Lưu ý: nếu sau này chạy nhiều instance trên Render thì cần chuyển sang Redis.

/**
 * Tạo middleware giới hạn request.
 * @param {object} opts
 * @param {number} opts.windowMs - độ dài cửa sổ thời gian (ms)
 * @param {number} opts.max - số request tối đa của mỗi IP trong cửa sổ
 * @param {string} [opts.name] - tên nhóm giới hạn (mỗi nhóm đếm riêng)
 */
export function rateLimit({ windowMs, max, name = 'default' }) {
    const hits = new Map(); // key -> { count, resetAt }

    // Dọn các bản ghi đã hết hạn để Map không phình to
    const timer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of hits) {
            if (entry.resetAt <= now) hits.delete(key);
        }
    }, windowMs);
    timer.unref(); // không giữ tiến trình sống chỉ vì bộ dọn này

    return function rateLimitMiddleware(req, res, next) {
        const now = Date.now();
        const key = `${name}:${req.ip}`;
        let entry = hits.get(key);

        if (!entry || entry.resetAt <= now) {
            entry = { count: 0, resetAt: now + windowMs };
            hits.set(key, entry);
        }

        entry.count += 1;

        if (entry.count > max) {
            const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
            res.set('Retry-After', String(retryAfter));
            return res.status(429).json({
                status: 'error',
                message: 'Bạn thao tác quá nhanh. Vui lòng thử lại sau ít phút.'
            });
        }

        next();
    };
}

// Chức năng: giới hạn số request (chống spam/brute-force), lưu trong bộ nhớ của 1 server. Mặc định đếm theo IP; có thể đếm theo khóa riêng (vd: người làm bài) và bỏ qua một số đường dẫn.
// Lưu ý: nếu sau này chạy nhiều instance trên Render thì cần chuyển sang Redis.

// Lấy IP thật của người dùng. Trên Render, req.ip thường là IP của proxy (mọi người dùng chung 1 IP),
// nên ưu tiên header do Cloudflare (phía trước Render) đặt, rồi mới dùng req.ip.
export function getClientIp(req) {
    return req.headers['cf-connecting-ip'] || req.headers['true-client-ip'] || req.ip;
}

/**
 * Tạo middleware giới hạn request.
 * @param {object} opts
 * @param {number} opts.windowMs - độ dài cửa sổ thời gian (ms)
 * @param {number} opts.max - số request tối đa của mỗi khóa trong cửa sổ
 * @param {string} [opts.name] - tên nhóm giới hạn (mỗi nhóm đếm riêng)
 * @param {(req) => string|undefined} [opts.keyFn] - khóa đếm riêng, vd: (req) => req.actor?.id. Không trả về gì thì dùng IP.
 *   Cả lớp học thường dùng chung một mạng Wi-Fi (cùng IP) nên các API làm bài đếm theo người làm, không theo IP.
 * @param {(req) => boolean} [opts.skip] - trả true để bỏ qua giới hạn này cho request đó
 */
export function rateLimit({ windowMs, max, name = 'default', keyFn, skip }) {
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
        if (skip && skip(req)) return next();

        const now = Date.now();
        const key = `${name}:${(keyFn && keyFn(req)) || getClientIp(req)}`;
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

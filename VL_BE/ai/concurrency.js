// Chức năng: giới hạn số lời gọi AI chạy đồng thời trên toàn server (worker và API dùng chung một bộ giới hạn).
// Lời gọi vượt giới hạn được xếp hàng chờ. Hàng chờ đầy, hoặc chờ quá lâu thì từ chối ngay (BusyError).
// Cấu hình bằng biến môi trường: AI_MAX_CONCURRENT (mặc định 2), AI_MAX_QUEUE (mặc định 20), AI_QUEUE_WAIT_MS (mặc định 60000).

export class BusyError extends Error {}

const readInt = (value, fallback) => {
    const n = Number.parseInt(value, 10);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
};

// Tạo một bộ giới hạn. acquire() trả về Promise<release>; gọi release() đúng một lần khi xong (gọi lần hai không làm gì).
export function createLimiter({ maxConcurrent = 2, maxQueue = 20, waitMs = 60_000 } = {}) {
    const slots = Math.max(1, maxConcurrent);
    let active = 0;
    const queue = []; // { resolve, timer }

    const makeRelease = () => {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            active--;
            drain();
        };
    };

    function drain() {
        while (active < slots && queue.length) {
            const item = queue.shift();
            clearTimeout(item.timer);
            active++;
            item.resolve(makeRelease());
        }
    }

    return {
        acquire() {
            if (active < slots) {
                active++;
                return Promise.resolve(makeRelease());
            }
            if (queue.length >= maxQueue) {
                return Promise.reject(new BusyError('Hệ thống AI đang quá tải, vui lòng thử lại sau'));
            }
            return new Promise((resolve, reject) => {
                const item = { resolve, timer: null };
                item.timer = setTimeout(() => {
                    const i = queue.indexOf(item);
                    if (i !== -1) {
                        queue.splice(i, 1);
                        reject(new BusyError('Hết thời gian chờ lượt gọi AI, vui lòng thử lại sau'));
                    }
                }, waitMs);
                queue.push(item);
            });
        },
        stats() {
            return { active, waiting: queue.length };
        }
    };
}

// Bộ giới hạn dùng chung cho toàn bộ lời gọi Gemini (ai/provider.js)
export const aiLimiter = createLimiter({
    maxConcurrent: readInt(process.env.AI_MAX_CONCURRENT, 2),
    maxQueue: readInt(process.env.AI_MAX_QUEUE, 20),
    waitMs: readInt(process.env.AI_QUEUE_WAIT_MS, 60_000)
});

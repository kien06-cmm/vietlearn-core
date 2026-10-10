// Chức năng: vòng lặp worker - lấy job từ hàng đợi Firestore, xử lý lần lượt; được "đánh thức" ngay khi có job mới.
import { claimNextJob, cleanupStaleUploads, processJob, recoverStaleJobs } from './jobRunner.js';
import { aiCooldown } from '../ai/cooldown.js';
import { AI_JOB_TYPES } from './queueRules.js';

const IDLE_POLL_MS = 30_000; // khi rảnh, kiểm tra hàng đợi mỗi 30 giây (tiết kiệm lượt đọc Firestore)
const RECOVER_EVERY_MS = 5 * 60_000;

let running = false;
let pendingWake = false;
let wakeNow = null;

function log(level, message, extra = {}) {
    console.log(JSON.stringify({ time: new Date().toISOString(), level, scope: 'worker', message, ...extra }));
}

// API gọi hàm này sau khi tạo job để worker chạy ngay, không phải chờ chu kỳ poll
export function wakeWorker() {
    pendingWake = true;
    if (wakeNow) wakeNow();
}

export function stopWorker() {
    running = false;
    if (wakeNow) wakeNow();
}

function sleepUntilWake(ms) {
    return new Promise((resolve) => {
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            wakeNow = null;
            resolve();
        }
        wakeNow = done;
    });
}

export function startWorker() {
    if (running) return;
    running = true;
    log('info', 'Worker khởi động');

    (async () => {
        let lastRecover = 0;
        while (running) {
            try {
                if (Date.now() - lastRecover > RECOVER_EVERY_MS) {
                    lastRecover = Date.now();
                    await recoverStaleJobs();
                    await cleanupStaleUploads();
                }
                // Gemini đang tạm nghỉ vì 429/hết quota: không nhận job dùng AI (job trích văn bản vẫn chạy bình thường)
                const excludeTypes = aiCooldown.remainingMs() > 0 ? AI_JOB_TYPES : [];
                const job = await claimNextJob({ excludeTypes });
                if (job) {
                    await processJob(job);
                    continue; // còn job thì làm tiếp ngay
                }
            } catch (err) {
                log('error', 'Lỗi vòng lặp worker', { error: err.message });
            }

            if (pendingWake) {
                pendingWake = false;
                continue;
            }
            // Đang tạm nghỉ AI: dậy đúng lúc hết nghỉ thay vì chờ hết chu kỳ poll
            const pause = aiCooldown.remainingMs();
            await sleepUntilWake(pause > 0 ? Math.min(pause + 500, IDLE_POLL_MS) : IDLE_POLL_MS);
            pendingWake = false;
        }
    })();
}

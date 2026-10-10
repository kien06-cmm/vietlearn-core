// Chức năng: AI credits theo chu kỳ 24 giờ của từng tài khoản.
// - Chu kỳ bắt đầu từ lần cấp đầu tiên của tài khoản và lặp lại đúng mỗi 24 giờ (KHÔNG reset cố định lúc 0 giờ).
// - Job chỉ giữ chỗ (reserve) khi worker BẮT ĐẦU chạy. Job còn nằm trong hàng đợi không khóa credit.
// - Thành công: chốt (settle) theo số câu thực tế lưu được. Thất bại: chốt với 0 => giải phóng toàn bộ phần giữ chỗ.
// - Không cộng dồn: hết chu kỳ thì used về 0. Credit đang giữ chỗ (job đang chạy) được giữ nguyên qua mốc reset.
// Sổ cái creditLedger/{key}_reserved, {key}_actual, {key}_refund. "key" là khóa của một lần giữ chỗ (xem attemptKey),
// nên chạy lại cùng khóa không giữ chỗ lần hai và không chốt lần hai.
import { FieldValue } from 'firebase-admin/firestore';
import { getDb as realGetDb } from './firebase.js';

// Chỉ dùng trong test: thay Firestore thật bằng bản giả trong bộ nhớ
let dbOverride = null;
export function _useDbForTests(db) {
    dbOverride = db;
}
const getDb = () => dbOverride || realGetDb();

export const CYCLE_MS = 24 * 3_600_000;

// Không đủ credits. resetsAt: lúc chu kỳ hiện tại kết thúc (ISO). window luôn là 'day' (chu kỳ 24 giờ).
export class QuotaError extends Error {
    constructor(message, { limit = 0, available = 0, resetsAt = null, window = 'day' } = {}) {
        super(message);
        this.limit = limit;
        this.available = available;
        this.resetsAt = resetsAt;
        this.window = window;
    }
}

// Khóa giữ chỗ cho MỘT lần chạy của job. Mỗi lần thử (attempt) là một khóa riêng để thử lại không bị tính chung.
export const attemptKey = (job) => `${job.id}_a${job.attempts || 1}`;

// limit: số (hạn mức mỗi 24 giờ) hoặc { daily } như cấu hình gói
const limitOf = (limit) => (typeof limit === 'number' ? limit : limit?.daily ?? 0);

const balanceRef = (uid) => getDb().collection('creditBalances').doc(uid);
const ledgerCol = () => getDb().collection('creditLedger');

// Chu kỳ hiện tại của tài khoản. data: bản ghi số dư (có thể không có). Trả { cycleStart (ms), used, reserved }.
export function rollCycle(data, now) {
    const anchor = typeof data?.cycleStart === 'number' ? data.cycleStart : now;
    const reserved = data?.reserved ?? 0;
    if (now < anchor + CYCLE_MS) return { cycleStart: anchor, used: data?.used ?? 0, reserved };
    // Quá một hoặc nhiều chu kỳ: dời mốc lên đúng bội số 24 giờ kể từ lần cấp đầu tiên
    const cycleStart = anchor + Math.floor((now - anchor) / CYCLE_MS) * CYCLE_MS;
    return { cycleStart, used: 0, reserved };
}

function stateOf(snap, limit, now) {
    const cur = rollCycle(snap?.data?.(), now);
    const max = limitOf(limit);
    return {
        ...cur,
        limit: max,
        remaining: Math.max(0, max - cur.used - cur.reserved),
        resetsAt: new Date(cur.cycleStart + CYCLE_MS).toISOString()
    };
}

const quotaError = (s, amount) =>
    new QuotaError(`Không đủ AI credits trong chu kỳ 24 giờ (còn ${s.remaining}, cần ${amount})`, {
        limit: s.limit,
        available: s.remaining,
        resetsAt: s.resetsAt,
        window: 'day'
    });

// Số dư hiện tại (không ghi gì). remaining = số credits dùng được ngay.
export async function getBalance(uid, limit, now = Date.now()) {
    const s = stateOf(await balanceRef(uid).get(), limit, now);
    return {
        period: new Date(s.cycleStart).toISOString(),
        limit: s.limit,
        used: s.used,
        reserved: s.reserved,
        remaining: s.remaining,
        window: 'day',
        resetsAt: s.resetsAt,
        week: null
    };
}

// Kiểm tra nhanh lúc NHẬN yêu cầu (chưa giữ chỗ). Không đủ thì ném QuotaError. Việc giữ chỗ thật diễn ra khi job chạy.
export async function assertCredits({ uid, amount, limit, now = Date.now() }) {
    const s = stateOf(await balanceRef(uid).get(), limit, now);
    if (amount > s.remaining) throw quotaError(s, amount);
    return { remaining: s.remaining, resetsAt: s.resetsAt };
}

// Giữ chỗ `amount` credits cho khóa jobId. Chạy lại cùng khóa thì không giữ thêm.
export async function reserveCredits({ uid, jobId, amount, limit, now = Date.now() }) {
    const ref = balanceRef(uid);
    const lRef = ledgerCol().doc(`${jobId}_reserved`);

    await getDb().runTransaction(async (tx) => {
        const [snap, done] = await Promise.all([tx.get(ref), tx.get(lRef)]);
        if (done.exists) return; // đã giữ chỗ cho khóa này rồi
        const s = stateOf(snap, limit, now);
        if (amount > s.remaining) throw quotaError(s, amount);

        tx.set(
            ref,
            { uid, cycleStart: s.cycleStart, used: s.used, reserved: s.reserved + amount, updatedAt: FieldValue.serverTimestamp() },
            { merge: true }
        );
        tx.set(lRef, { uid, kind: 'reserved', amount, jobId, at: FieldValue.serverTimestamp() });
    });
    return { reserved: amount };
}

// Chốt khóa jobId: trừ `actual` credits đã dùng (bị chặn trong [0, số đã giữ]), hoàn phần còn lại.
// actual = 0 nghĩa là hoàn toàn bộ (job lỗi). Không giữ chỗ trước => không làm gì. Chốt hai lần => không làm gì (trả false).
export async function settleCredits({ uid, jobId, actual, now = Date.now() }) {
    const ref = balanceRef(uid);
    const lRef = ledgerCol().doc(`${jobId}_reserved`);
    const marker = ledgerCol().doc(`${jobId}_actual`);

    return getDb().runTransaction(async (tx) => {
        const [snap, res, done] = await Promise.all([tx.get(ref), tx.get(lRef), tx.get(marker)]);
        if (!res.exists || done.exists) return false;

        const reserved = Number(res.data().amount) || 0;
        const used = Math.min(Math.max(Math.trunc(Number(actual) || 0), 0), reserved);
        const refund = reserved - used;
        const cur = rollCycle(snap?.data?.(), now);

        tx.set(
            ref,
            {
                uid,
                cycleStart: cur.cycleStart,
                used: cur.used + used,
                reserved: Math.max(0, cur.reserved - reserved),
                updatedAt: FieldValue.serverTimestamp()
            },
            { merge: true }
        );
        tx.set(marker, { uid, kind: 'actual', amount: used, jobId, at: FieldValue.serverTimestamp() });
        if (refund > 0) {
            tx.set(ledgerCol().doc(`${jobId}_refund`), { uid, kind: 'refund', amount: refund, jobId, at: FieldValue.serverTimestamp() });
        }
        return true;
    });
}

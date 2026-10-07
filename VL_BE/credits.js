// Chức năng: AI Credits (Phase 3) - giữ chỗ (reserved) trước khi gọi AI, chốt (actual) khi xong, hoàn (refund) phần không dùng.
// Hạn mức tính theo NGÀY và theo TUẦN: mỗi ngày dùng tối đa `daily` credits, cả tuần tối đa `weekly` credits (tuần bắt đầu thứ Hai).
// Hết bên nào thì chờ bên đó làm mới. Mốc làm mới tính theo giờ Việt Nam (xem RESET_HOUR_VN).
// Sổ cái: creditLedger/{jobId}_{kind} (id cố định => chạy lại không ghi trùng).
// Số dư: creditBalances/{uid}_{YYYY-MM-DD} (ngày) và creditBalances/{uid}_w{YYYY-MM-DD thứ Hai} (tuần).
import { FieldValue } from 'firebase-admin/firestore';
import { getDb as realGetDb } from './firebase.js';

// Chỉ dùng trong test: thay Firestore thật bằng bản giả trong bộ nhớ
let dbOverride = null;
export function _useDbForTests(db) {
    dbOverride = db;
}
const getDb = () => dbOverride || realGetDb();

// Giờ (theo giờ Việt Nam, UTC+7) mà hạn mức ngày/tuần được làm mới. 0 = nửa đêm, 22 = "dùng lại lúc 22:00".
export const RESET_HOUR_VN = 0;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const SHIFT_MS = (7 - RESET_HOUR_VN) * HOUR; // dịch giờ UTC sang "lịch" có ranh giới ngày đúng tại giờ reset

// Không đủ credits. resetsAt: lúc được làm mới (ISO). window: 'day' hoặc 'week' (hạn mức nào đang chặn).
export class QuotaError extends Error {
    constructor(message, { limit = 0, available = 0, resetsAt = null, window = 'day' } = {}) {
        super(message);
        this.limit = limit;
        this.available = available;
        this.resetsAt = resetsAt;
        this.window = window;
    }
}

// Kỳ tính credits = ngày hiện tại, ví dụ "2026-10-07" (ranh giới ngày tại RESET_HOUR_VN giờ Việt Nam)
export const currentPeriod = (date = new Date()) => new Date(date.getTime() + SHIFT_MS).toISOString().slice(0, 10);

const isDayKey = (p) => /^\d{4}-\d{2}-\d{2}$/.test(String(p));
const dayStartMs = (day) => Date.parse(`${day}T00:00:00Z`) - SHIFT_MS;

// Ngày thứ Hai đầu tuần chứa `day`, ví dụ "2026-10-05"
export const weekKey = (day) => {
    const d = new Date(`${day}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
};

// Lúc hạn mức ngày / tuần được làm mới (ISO). Giao diện đếm ngược theo các mốc này.
export const periodEnd = (period) => new Date(dayStartMs(period) + DAY).toISOString();
export const weekEnd = (period) => new Date(dayStartMs(weekKey(period)) + 7 * DAY).toISOString();

const balanceRef = (uid, key) => getDb().collection('creditBalances').doc(`${uid}_${key}`);
const dayRef = (uid, period) => balanceRef(uid, period);
const weekRef = (uid, period) => balanceRef(uid, `w${weekKey(period)}`);
const ledgerCol = () => getDb().collection('creditLedger');

// limit: số (chỉ giới hạn theo ngày) hoặc { daily, weekly }
const splitLimit = (limit) =>
    typeof limit === 'number' ? { daily: limit, weekly: null } : { daily: limit.daily, weekly: limit.weekly ?? null };

const windowState = (snap, limit) => {
    const used = snap?.data()?.used ?? 0;
    const reserved = snap?.data()?.reserved ?? 0;
    return { limit, used, reserved, remaining: Math.max(0, limit - used - reserved) };
};

// Số dư hiện tại. remaining = số credits dùng được ngay (nhỏ hơn của ngày và tuần).
// resetsAt/window: lúc nào và hạn mức nào làm remaining tăng lên (tuần nếu hạn mức tuần đang là giới hạn chặt hơn).
export async function getBalance(uid, limit) {
    const { daily, weekly } = splitLimit(limit);
    const period = currentPeriod();
    const [dSnap, wSnap] = await Promise.all([dayRef(uid, period).get(), weekly != null ? weekRef(uid, period).get() : null]);

    const d = windowState(dSnap, daily);
    const w = weekly != null ? windowState(wSnap, weekly) : null;
    const weekBinds = w !== null && w.remaining <= d.remaining;

    return {
        period,
        limit: daily,
        used: d.used,
        reserved: d.reserved,
        remaining: w ? Math.min(d.remaining, w.remaining) : d.remaining,
        window: weekBinds ? 'week' : 'day',
        resetsAt: weekBinds ? weekEnd(period) : periodEnd(period),
        week: w ? { ...w, resetsAt: weekEnd(period) } : null
    };
}

// Kiểm tra quota rồi giữ chỗ `amount` credits. `writes(tx)` (tùy chọn) chạy trong CÙNG transaction
// để việc tạo job và việc giữ chỗ là một: hoặc cùng có, hoặc cùng không.
export async function reserveCredits({ uid, jobId, amount, limit, writes }) {
    const { daily, weekly } = splitLimit(limit);
    const period = currentPeriod();
    const dRef = dayRef(uid, period);
    const wRef = weekly != null ? weekRef(uid, period) : null;

    await getDb().runTransaction(async (tx) => {
        const [dSnap, wSnap] = await Promise.all([tx.get(dRef), wRef ? tx.get(wRef) : null]);
        const d = windowState(dSnap, daily);
        const w = wRef ? windowState(wSnap, weekly) : null;

        const available = w ? Math.min(d.remaining, w.remaining) : d.remaining;
        if (amount > available) {
            const weekBinds = w !== null && w.remaining <= d.remaining;
            throw new QuotaError(
                `Không đủ AI credits ${weekBinds ? 'tuần này' : 'hôm nay'} (còn ${available}, cần ${amount})`,
                { limit: daily, available, window: weekBinds ? 'week' : 'day', resetsAt: weekBinds ? weekEnd(period) : periodEnd(period) }
            );
        }

        tx.set(
            dRef,
            { uid, period, used: d.used, reserved: d.reserved + amount, updatedAt: FieldValue.serverTimestamp() },
            { merge: true }
        );
        if (wRef) {
            tx.set(
                wRef,
                { uid, period: `w${weekKey(period)}`, used: w.used, reserved: w.reserved + amount, updatedAt: FieldValue.serverTimestamp() },
                { merge: true }
            );
        }
        tx.set(ledgerCol().doc(`${jobId}_reserved`), {
            uid,
            kind: 'reserved',
            amount,
            estimated: amount,
            jobId,
            period,
            at: FieldValue.serverTimestamp()
        });
        if (writes) writes(tx);
    });

    return { period, reserved: amount };
}

// Chốt job: tính `actual` credits đã dùng, hoàn phần còn lại. actual = 0 nghĩa là hoàn toàn bộ (job lỗi).
// `period` là kỳ ngày lúc giữ chỗ; hạn mức tuần suy ra từ đó. Idempotent: gọi lại lần hai không làm gì (trả false).
export async function settleCredits({ uid, jobId, period, reserved, actual }) {
    const dRef = dayRef(uid, period);
    const wRef = isDayKey(period) ? weekRef(uid, period) : null; // kỳ kiểu cũ (theo tháng) thì không có hạn mức tuần
    const marker = ledgerCol().doc(`${jobId}_actual`);

    return getDb().runTransaction(async (tx) => {
        const [done, dBal, wBal] = await Promise.all([tx.get(marker), tx.get(dRef), wRef ? tx.get(wRef) : null]);
        if (done.exists) return false;

        const used = Math.min(Math.max(Math.trunc(actual), 0), reserved);
        const refund = reserved - used;
        const apply = (cur = {}) => ({
            used: (cur.used ?? 0) + used,
            reserved: Math.max(0, (cur.reserved ?? 0) - reserved),
            updatedAt: FieldValue.serverTimestamp()
        });

        tx.set(dRef, { uid, period, ...apply(dBal.data()) }, { merge: true });
        if (wBal?.exists) tx.set(wRef, { uid, ...apply(wBal.data()) }, { merge: true });

        tx.set(marker, { uid, kind: 'actual', amount: used, jobId, period, at: FieldValue.serverTimestamp() });
        if (refund > 0) {
            tx.set(ledgerCol().doc(`${jobId}_refund`), {
                uid,
                kind: 'refund',
                amount: refund,
                jobId,
                period,
                at: FieldValue.serverTimestamp()
            });
        }
        return true;
    });
}

// Chức năng: AI Credits (Phase 3) - giữ chỗ (reserved) trước khi gọi AI, chốt (actual) khi xong, hoàn (refund) phần không dùng.
// Sổ cái: creditLedger/{jobId}_{kind} (id cố định => chạy lại không ghi trùng). Số dư theo tháng: creditBalances/{uid}_{YYYY-MM}.
import { FieldValue } from 'firebase-admin/firestore';
import { getDb as realGetDb } from './firebase.js';

// Chỉ dùng trong test: thay Firestore thật bằng bản giả trong bộ nhớ
let dbOverride = null;
export function _useDbForTests(db) {
    dbOverride = db;
}
const getDb = () => dbOverride || realGetDb();

// Không đủ credits trong tháng
export class QuotaError extends Error {
    constructor(message, { limit = 0, available = 0 } = {}) {
        super(message);
        this.limit = limit;
        this.available = available;
    }
}

// Kỳ tính credits: tháng theo UTC, ví dụ "2026-10"
export const currentPeriod = (date = new Date()) => date.toISOString().slice(0, 7);

// Thời điểm kỳ kết thúc = lúc credits được làm mới (đầu tháng sau, 0h UTC), dạng ISO.
// Giao diện đếm ngược theo mốc này. Muốn đổi sang chu kỳ khác (vd: mỗi 8 giờ) thì chỉ cần sửa hàm này và currentPeriod.
export const periodEnd = (period) => {
    const [y, m] = period.split('-').map(Number);
    return new Date(Date.UTC(y, m, 1)).toISOString();
};

const balanceRef = (uid, period) => getDb().collection('creditBalances').doc(`${uid}_${period}`);
const ledgerCol = () => getDb().collection('creditLedger');

// Số dư tháng hiện tại
export async function getBalance(uid, limit) {
    const period = currentPeriod();
    const snap = await balanceRef(uid, period).get();
    const used = snap.data()?.used ?? 0;
    const reserved = snap.data()?.reserved ?? 0;
    return { period, limit, used, reserved, remaining: Math.max(0, limit - used - reserved), resetsAt: periodEnd(period) };
}

// Kiểm tra quota rồi giữ chỗ `amount` credits. `writes(tx)` (tùy chọn) chạy trong CÙNG transaction
// để việc tạo job và việc giữ chỗ là một: hoặc cùng có, hoặc cùng không.
export async function reserveCredits({ uid, jobId, amount, limit, writes }) {
    const period = currentPeriod();
    const ref = balanceRef(uid, period);

    await getDb().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const used = snap.data()?.used ?? 0;
        const reserved = snap.data()?.reserved ?? 0;
        const available = Math.max(0, limit - used - reserved);
        if (amount > available) {
            throw new QuotaError(`Không đủ AI credits (còn ${available}, cần ${amount})`, { limit, available });
        }

        tx.set(
            ref,
            { uid, period, used, reserved: reserved + amount, updatedAt: FieldValue.serverTimestamp() },
            { merge: true }
        );
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
// Idempotent: gọi lại lần hai không làm gì (trả false).
export async function settleCredits({ uid, jobId, period, reserved, actual }) {
    const ref = balanceRef(uid, period);
    const marker = ledgerCol().doc(`${jobId}_actual`);

    return getDb().runTransaction(async (tx) => {
        const [done, bal] = await Promise.all([tx.get(marker), tx.get(ref)]);
        if (done.exists) return false;

        const used = Math.min(Math.max(Math.trunc(actual), 0), reserved);
        const refund = reserved - used;
        const cur = bal.data() || {};

        tx.set(
            ref,
            {
                uid,
                period,
                used: (cur.used ?? 0) + used,
                reserved: Math.max(0, (cur.reserved ?? 0) - reserved),
                updatedAt: FieldValue.serverTimestamp()
            },
            { merge: true }
        );
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

// Chức năng: kiểm thử AI Credits theo chu kỳ 24 giờ - giữ chỗ, chốt, giải phóng, không trừ hai lần, reset đúng 24 giờ.
// Dùng Firestore giả trong bộ nhớ và tham số `now` để chỉnh thời gian. Chạy: npm test
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CYCLE_MS, QuotaError, _useDbForTests, assertCredits, attemptKey, getBalance, reserveCredits, rollCycle, settleCredits } from '../credits.js';

// Firestore giả, đủ cho credits.js: collection().doc().get(), runTransaction với tx.get/tx.set (có merge).
// Transaction chỉ ghi khi hàm chạy xong không lỗi (đúng tính "cùng có hoặc cùng không" của Firestore).
function makeFakeDb() {
    const store = new Map();
    const snap = (key) => ({ exists: store.has(key), data: () => (store.has(key) ? structuredClone(store.get(key)) : undefined) });
    const ref = (col, id) => ({ key: `${col}/${id}`, get: async () => snap(`${col}/${id}`) });
    return {
        store,
        collection: (col) => ({ doc: (id) => ref(col, id) }),
        runTransaction: async (fn) => {
            const pending = [];
            const tx = {
                get: async (r) => snap(r.key),
                set: (r, data, opts) => pending.push({ r, data, merge: Boolean(opts?.merge) })
            };
            const result = await fn(tx);
            for (const { r, data, merge } of pending) {
                store.set(r.key, merge ? { ...store.get(r.key), ...data } : data);
            }
            return result;
        }
    };
}

const UID = 'user1';
const LIMIT = 50;
const T0 = Date.parse('2026-10-01T23:00:00+07:00'); // 23:00 giờ Việt Nam: đã từng bị reset nhầm lúc 0 giờ
let db;

beforeEach(() => {
    db = makeFakeDb();
    _useDbForTests(db);
});

const reserve = (jobId, amount, now = T0) => reserveCredits({ uid: UID, jobId, amount, limit: LIMIT, now });
const settle = (jobId, actual, now = T0) => settleCredits({ uid: UID, jobId, actual, now });
const balance = (now = T0) => getBalance(UID, LIMIT, now);

test('giữ chỗ làm giảm số dư còn lại', async () => {
    await reserve('job1', 20);
    const b = await balance();
    assert.equal(b.reserved, 20);
    assert.equal(b.used, 0);
    assert.equal(b.remaining, 30);
});

test('không đủ credits thì báo QuotaError và không đổi số dư', async () => {
    await reserve('job1', 40);
    await assert.rejects(() => reserve('job2', 11), QuotaError);
    const b = await balance();
    assert.equal(b.reserved, 40);
    assert.equal(db.store.has('creditLedger/job2_reserved'), false);
});

test('giữ chỗ nhiều job cộng dồn, đủ đúng hạn mức thì vẫn được', async () => {
    await reserve('job1', 30);
    await reserve('job2', 20);
    assert.equal((await balance()).remaining, 0);
    await assert.rejects(() => reserve('job3', 1), QuotaError);
});

test('giữ chỗ cùng một khóa hai lần KHÔNG giữ hai lần', async () => {
    await reserve('job1', 20);
    await reserve('job1', 20);
    assert.equal((await balance()).reserved, 20);
});

test('assertCredits: đủ thì qua, thiếu thì ném QuotaError, và không giữ chỗ gì', async () => {
    await assertCredits({ uid: UID, amount: 50, limit: LIMIT, now: T0 });
    await reserve('job1', 45);
    await assert.rejects(() => assertCredits({ uid: UID, amount: 6, limit: LIMIT, now: T0 }), QuotaError);
    assert.equal((await balance()).reserved, 45, 'kiểm tra không được tự giữ chỗ');
});

test('chốt job dùng ít hơn dự kiến: trừ đúng số dùng, hoàn phần dư', async () => {
    await reserve('job1', 20);
    assert.equal(await settle('job1', 12), true);

    const b = await balance();
    assert.equal(b.used, 12);
    assert.equal(b.reserved, 0);
    assert.equal(b.remaining, 38);
    assert.equal(db.store.get('creditLedger/job1_refund').amount, 8);
    assert.equal(db.store.get('creditLedger/job1_actual').amount, 12);
});

test('job lỗi (actual = 0): giải phóng toàn bộ credits', async () => {
    await reserve('job1', 20);
    await settle('job1', 0);
    const b = await balance();
    assert.equal(b.used, 0);
    assert.equal(b.reserved, 0);
    assert.equal(b.remaining, LIMIT);
    assert.equal(db.store.get('creditLedger/job1_refund').amount, 20);
});

test('job dùng đủ: không có dòng hoàn', async () => {
    await reserve('job1', 20);
    await settle('job1', 20);
    assert.equal((await balance()).used, 20);
    assert.equal(db.store.has('creditLedger/job1_refund'), false);
});

test('chốt hai lần cùng một job KHÔNG trừ hai lần', async () => {
    await reserve('job1', 20);
    assert.equal(await settle('job1', 12), true);
    const after1 = await balance();
    assert.equal(await settle('job1', 12), false);
    assert.deepEqual(await balance(), after1);
});

test('giải phóng hai lần cùng một job KHÔNG hoàn dư', async () => {
    await reserve('job1', 20);
    await reserve('job2', 10);
    await settle('job1', 0);
    await settle('job1', 0); // worker chạy lại
    const b = await balance();
    assert.equal(b.reserved, 10, 'phần giữ chỗ của job2 phải còn nguyên');
    assert.equal(b.remaining, 40);
});

test('chốt job chưa từng giữ chỗ (ví dụ thất bại trước khi chạy) không làm gì', async () => {
    assert.equal(await settle('never-reserved', 0), false);
    assert.equal(db.store.has('creditBalances/user1'), false);
});

test('actual lớn hơn số đã giữ bị chặn ở mức đã giữ', async () => {
    await reserve('job1', 10);
    await settle('job1', 999);
    assert.equal((await balance()).used, 10);
});

test('actual âm hoặc số lẻ được chuẩn hóa', async () => {
    await reserve('job1', 10);
    await reserve('job2', 10);
    await settle('job1', -5);
    await settle('job2', 3.9);
    const b = await balance();
    assert.equal(b.used, 3);
    assert.equal(b.reserved, 0);
});

test('credits của hai người dùng độc lập', async () => {
    await reserveCredits({ uid: 'userA', jobId: 'a1', amount: 50, limit: LIMIT, now: T0 });
    await reserveCredits({ uid: 'userB', jobId: 'b1', amount: 50, limit: LIMIT, now: T0 });
    assert.equal((await getBalance('userA', LIMIT, T0)).remaining, 0);
    assert.equal((await getBalance('userB', LIMIT, T0)).remaining, 0);
});

test('khóa giữ chỗ theo lần thử: thử lại không cộng dồn với lần trước', () => {
    assert.equal(attemptKey({ id: 'j9', attempts: 2 }), 'j9_a2');
    assert.equal(attemptKey({ id: 'j9' }), 'j9_a1');
});

// ---------- Chu kỳ 24 giờ ----------

test('chu kỳ bắt đầu từ lần cấp đầu tiên, không reset lúc 0 giờ', async () => {
    await reserve('job1', 40, T0); // 23:00 ngày 1
    // 00:30 ngày 2 (chưa đủ 24 giờ kể từ lần cấp đầu tiên): vẫn còn 40 đã dùng
    const midnight = T0 + 90 * 60_000;
    assert.equal((await balance(midnight)).remaining, 10);
});

test('đủ 24 giờ kể từ lần cấp: số dư về đầy đủ', async () => {
    await reserve('job1', 40, T0);
    await settle('job1', 40, T0);
    assert.equal((await balance(T0 + CYCLE_MS - 1)).remaining, 10, 'còn 1 ms là chưa reset');
    const after = await balance(T0 + CYCLE_MS);
    assert.equal(after.remaining, LIMIT);
    assert.equal(after.used, 0);
});

test('resetsAt là đúng 24 giờ sau mốc bắt đầu chu kỳ', async () => {
    await reserve('job1', 5, T0);
    const b = await balance(T0 + 3_600_000);
    assert.equal(b.resetsAt, new Date(T0 + CYCLE_MS).toISOString());
});

test('chu kỳ dời theo bội số 24 giờ, không trôi theo lần dùng sau', async () => {
    await reserve('job1', 40, T0);
    await settle('job1', 40, T0);
    // Lần dùng tiếp theo sau 30 giờ: chu kỳ mới bắt đầu tại T0 + 24h, không phải T0 + 30h
    const later = T0 + 30 * 3_600_000;
    await reserve('job2', 10, later);
    const cur = db.store.get(`creditBalances/${UID}`);
    assert.equal(cur.cycleStart, T0 + CYCLE_MS);
    assert.equal(cur.used, 0);
    assert.equal(cur.reserved, 10);
});

test('credit đang giữ chỗ (job đang chạy) được giữ nguyên qua mốc reset', async () => {
    await reserve('job1', 30, T0); // job vẫn đang chạy
    const reset = T0 + CYCLE_MS + 60_000;
    const b = await balance(reset);
    assert.equal(b.reserved, 30);
    assert.equal(b.remaining, 20);
});

test('rollCycle: chưa có số dư thì bắt đầu chu kỳ ngay lúc đó', () => {
    const r = rollCycle(undefined, T0);
    assert.equal(r.cycleStart, T0);
    assert.equal(r.used, 0);
    assert.equal(r.reserved, 0);
});

test('rollCycle: nghỉ nhiều ngày vẫn chỉ lên đúng bội số 24 giờ', () => {
    const r = rollCycle({ cycleStart: T0, used: 40, reserved: 0 }, T0 + 3 * CYCLE_MS + 5 * 3_600_000);
    assert.equal(r.cycleStart, T0 + 3 * CYCLE_MS);
    assert.equal(r.used, 0);
});

// Chức năng: kiểm thử AI Credits - giữ chỗ, chốt, hoàn, và không trừ hai lần. Dùng Firestore giả trong bộ nhớ. Chạy: npm test
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
    QuotaError,
    _useDbForTests,
    currentPeriod,
    getBalance,
    periodEnd,
    reserveCredits,
    settleCredits,
    weekEnd,
    weekKey
} from '../credits.js';

// Firestore giả, đủ cho credits.js: collection().doc().get(), runTransaction với tx.get/tx.set (có merge).
// Transaction chỉ ghi khi hàm chạy xong không lỗi (đúng tính "cùng có hoặc cùng không" của Firestore).
function makeFakeDb() {
    const store = new Map();
    const snap = (key) => ({ exists: store.has(key), data: () => store.get(key) });
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
const period = currentPeriod();
let db;

beforeEach(() => {
    db = makeFakeDb();
    _useDbForTests(db);
});

const reserve = (jobId, amount) => reserveCredits({ uid: UID, jobId, amount, limit: LIMIT });
const settle = (jobId, reserved, actual) => settleCredits({ uid: UID, jobId, period, reserved, actual });
const balance = () => getBalance(UID, LIMIT);

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
    assert.equal(db.store.has(`creditLedger/job2_reserved`), false);
});

test('giữ chỗ nhiều job cộng dồn, đủ đúng hạn mức thì vẫn được', async () => {
    await reserve('job1', 30);
    await reserve('job2', 20);
    assert.equal((await balance()).remaining, 0);
    await assert.rejects(() => reserve('job3', 1), QuotaError);
});

test('tạo job và giữ chỗ nằm trong cùng transaction', async () => {
    await reserveCredits({
        uid: UID,
        jobId: 'job1',
        amount: 10,
        limit: LIMIT,
        writes: (tx) => tx.set(db.collection('jobs').doc('job1'), { status: 'queued' })
    });
    assert.equal(db.store.get('jobs/job1').status, 'queued');
    assert.equal((await balance()).reserved, 10);
});

test('hết quota thì job KHÔNG được tạo (không có job mồ côi)', async () => {
    await assert.rejects(
        () =>
            reserveCredits({
                uid: UID,
                jobId: 'job1',
                amount: LIMIT + 1,
                limit: LIMIT,
                writes: (tx) => tx.set(db.collection('jobs').doc('job1'), { status: 'queued' })
            }),
        QuotaError
    );
    assert.equal(db.store.has('jobs/job1'), false);
});

test('chốt job dùng ít hơn dự kiến: trừ đúng số dùng, hoàn phần dư', async () => {
    await reserve('job1', 20);
    assert.equal(await settle('job1', 20, 12), true);

    const b = await balance();
    assert.equal(b.used, 12);
    assert.equal(b.reserved, 0);
    assert.equal(b.remaining, 38);
    assert.equal(db.store.get('creditLedger/job1_refund').amount, 8);
    assert.equal(db.store.get('creditLedger/job1_actual').amount, 12);
});

test('job lỗi (actual = 0): hoàn toàn bộ credits', async () => {
    await reserve('job1', 20);
    await settle('job1', 20, 0);

    const b = await balance();
    assert.equal(b.used, 0);
    assert.equal(b.reserved, 0);
    assert.equal(b.remaining, LIMIT);
    assert.equal(db.store.get('creditLedger/job1_refund').amount, 20);
});

test('job dùng đủ: không có dòng hoàn', async () => {
    await reserve('job1', 20);
    await settle('job1', 20, 20);

    assert.equal((await balance()).used, 20);
    assert.equal(db.store.has('creditLedger/job1_refund'), false);
});

test('chốt hai lần cùng một job KHÔNG trừ hai lần', async () => {
    await reserve('job1', 20);
    assert.equal(await settle('job1', 20, 12), true);
    const after1 = await balance();

    assert.equal(await settle('job1', 20, 12), false);
    assert.deepEqual(await balance(), after1);
});

test('hoàn hai lần cùng một job lỗi KHÔNG hoàn dư', async () => {
    await reserve('job1', 20);
    await reserve('job2', 10);
    await settle('job1', 20, 0);
    await settle('job1', 20, 0); // worker chạy lại

    const b = await balance();
    assert.equal(b.reserved, 10, 'phần giữ chỗ của job2 phải còn nguyên');
    assert.equal(b.remaining, 40);
});

test('actual lớn hơn reserved bị chặn ở mức reserved', async () => {
    await reserve('job1', 10);
    await settle('job1', 10, 999);
    assert.equal((await balance()).used, 10);
});

test('actual âm hoặc số lẻ được chuẩn hóa', async () => {
    await reserve('job1', 10);
    await reserve('job2', 10);
    await settle('job1', 10, -5);
    await settle('job2', 10, 3.9);

    const b = await balance();
    assert.equal(b.used, 3);
    assert.equal(b.reserved, 0);
});

test('credits của hai người dùng độc lập', async () => {
    await reserveCredits({ uid: 'userA', jobId: 'a1', amount: 50, limit: LIMIT });
    await reserveCredits({ uid: 'userB', jobId: 'b1', amount: 50, limit: LIMIT });
    assert.equal((await getBalance('userA', LIMIT)).remaining, 0);
    assert.equal((await getBalance('userB', LIMIT)).remaining, 0);
});

// ---------- Hạn mức theo ngày + tuần ----------
const LIMITS = { daily: 10, weekly: 35 };
const reserveW = (jobId, amount) => reserveCredits({ uid: UID, jobId, amount, limit: LIMITS });

test('tuần bắt đầu từ thứ Hai', () => {
    assert.equal(weekKey('2026-10-07'), '2026-10-05'); // thứ Năm -> thứ Hai cùng tuần
    assert.equal(weekKey('2026-10-05'), '2026-10-05');
    assert.equal(weekKey('2026-10-11'), '2026-10-05'); // Chủ nhật vẫn thuộc tuần trước
    assert.equal(weekKey('2026-10-12'), '2026-10-12');
});

test('mốc làm mới tuần sau mốc làm mới ngày, cách nhau tối đa 7 ngày', () => {
    const day = Date.parse(periodEnd(period));
    const week = Date.parse(weekEnd(period));
    assert.ok(week >= day);
    assert.ok(week - day < 7 * 24 * 3_600_000);
});

test('hết hạn mức NGÀY: báo window=day và mốc làm mới là cuối ngày', async () => {
    await reserveW('job1', 10);
    await assert.rejects(
        () => reserveW('job2', 1),
        (err) => err instanceof QuotaError && err.window === 'day' && err.resetsAt === periodEnd(period)
    );
    const b = await getBalance(UID, LIMITS);
    assert.equal(b.remaining, 0);
    assert.equal(b.window, 'day');
    assert.equal(b.week.remaining, 25);
});

test('hết hạn mức TUẦN dù ngày còn: bị chặn và mốc làm mới là cuối tuần', async () => {
    db.store.set(`creditBalances/${UID}_w${weekKey(period)}`, { used: 33, reserved: 0 });
    await assert.rejects(
        () => reserveW('job1', 5),
        (err) => err instanceof QuotaError && err.window === 'week' && err.resetsAt === weekEnd(period)
    );
    const b = await getBalance(UID, LIMITS);
    assert.equal(b.remaining, 2);
    assert.equal(b.window, 'week');
    assert.equal(b.resetsAt, weekEnd(period));
});

test('giữ chỗ trừ cả ngày lẫn tuần; chốt hoàn phần dư cho cả hai', async () => {
    await reserveW('job1', 6);
    let b = await getBalance(UID, LIMITS);
    assert.equal(b.remaining, 4);
    assert.equal(b.week.remaining, 29);

    await settleCredits({ uid: UID, jobId: 'job1', period, reserved: 6, actual: 4 });
    b = await getBalance(UID, LIMITS);
    assert.equal(b.used, 4);
    assert.equal(b.remaining, 6);
    assert.equal(b.week.used, 4);
    assert.equal(b.week.reserved, 0);
    assert.equal(b.week.remaining, 31);
});

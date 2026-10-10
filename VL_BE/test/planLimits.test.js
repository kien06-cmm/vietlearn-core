// Chức năng: kiểm thử giới hạn theo gói (Free/Pro): AI credits mỗi ngày, số câu tạo mỗi job, số câu nhập mỗi lần, và việc credits làm mới sang ngày mới (không cộng dồn). Chạy: npm test
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, creditLimits, getPlan } from '../config/plans.js';
import { finalizeImport, parseQuestionRows } from '../ai/importRules.js';
import { CYCLE_MS, _useDbForTests, getBalance, reserveCredits, settleCredits } from '../credits.js';

// ---------- Cấu hình gói ----------
test('Free: 10 credits/ngày, tạo tối đa 10 câu/job, nhập tối đa 20 câu', () => {
    assert.equal(PLANS.free.aiCreditsPerDay, 10);
    assert.equal(PLANS.free.maxQuestionsPerJob, 10);
    assert.equal(PLANS.free.maxImportQuestions, 20);
});

test('Pro: 40 credits/ngày, tạo tối đa 40 câu/job, nhập tối đa 200 câu', () => {
    assert.equal(PLANS.pro.aiCreditsPerDay, 40);
    assert.equal(PLANS.pro.maxQuestionsPerJob, 40);
    assert.equal(PLANS.pro.maxImportQuestions, 200);
});

test('gói không tồn tại hoặc thiếu thì rơi về Free; creditLimits lấy đúng hạn mức ngày', () => {
    assert.equal(getPlan(undefined), PLANS.free);
    assert.equal(getPlan('abc'), PLANS.free);
    assert.deepEqual(creditLimits(PLANS.free), { daily: 10, weekly: null });
    assert.deepEqual(creditLimits(PLANS.pro), { daily: 40, weekly: null });
});

// ---------- Giới hạn số câu nhập ----------
const HEADER = ['Câu hỏi', 'A', 'B', 'C', 'D', 'Đáp án'];

// Đề khác hẳn nhau từ ngữ để không bị luật loại trùng chặn nhầm
function distinctRows(n) {
    let seed = 12345;
    const word = () => {
        let w = '';
        for (let i = 0; i < 6; i++) {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            w += String.fromCharCode(97 + (seed % 26));
        }
        return w;
    };
    const rows = [HEADER];
    for (let i = 0; i < n; i++) {
        rows.push([`${word()} ${word()} ${word()} ${word()} ${word()}`, word(), word(), word(), word(), 'A']);
    }
    return rows;
}

test('nhập Excel gói Free: 25 câu hợp lệ chỉ nhận 20, báo rõ 5 câu chưa nhập', () => {
    const { questions, errors } = finalizeImport(parseQuestionRows(distinctRows(25)), { maxQuestions: PLANS.free.maxImportQuestions });
    assert.equal(questions.length, 20);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /giới hạn 20 câu/);
    assert.match(errors[0].message, /5 câu/);
});

test('nhập Excel gói Pro: 25 câu đều được nhận', () => {
    const { questions, errors } = finalizeImport(parseQuestionRows(distinctRows(25)), { maxQuestions: PLANS.pro.maxImportQuestions });
    assert.equal(questions.length, 25);
    assert.equal(errors.length, 0);
});

test('đúng 20 câu ở gói Free vẫn nhập được hết', () => {
    const { questions, errors } = finalizeImport(parseQuestionRows(distinctRows(20)), { maxQuestions: PLANS.free.maxImportQuestions });
    assert.equal(questions.length, 20);
    assert.equal(errors.length, 0);
});

// ---------- Credits làm mới theo chu kỳ 24 giờ (tính từ lần cấp đầu tiên, không phải 0 giờ) ----------
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
            for (const { r, data, merge } of pending) store.set(r.key, merge ? { ...store.get(r.key), ...data } : data);
            return result;
        }
    };
}

const UID = 'user1';
const LIMITS = creditLimits(PLANS.free);
let db;

beforeEach(() => {
    db = makeFakeDb();
    _useDbForTests(db);
});

test('hết chu kỳ 24 giờ trước thì chu kỳ mới có lại đủ 10, không cộng dồn', async () => {
    const now = Date.now();
    db.store.set(`creditBalances/${UID}`, { uid: UID, cycleStart: now - CYCLE_MS - 1000, used: 10, reserved: 0 });

    const b = await getBalance(UID, LIMITS, now);
    assert.equal(b.remaining, 10);
    assert.equal(b.used, 0);
});

test('chưa hết chu kỳ thì vẫn giữ số đã dùng', async () => {
    const now = Date.now();
    db.store.set(`creditBalances/${UID}`, { uid: UID, cycleStart: now - CYCLE_MS + 60_000, used: 10, reserved: 0 });

    const b = await getBalance(UID, LIMITS, now);
    assert.equal(b.remaining, 0);
});

test('credits chưa dùng ở chu kỳ trước KHÔNG được cộng thêm vào chu kỳ mới', async () => {
    const b = await getBalance(UID, LIMITS);
    assert.equal(b.remaining, PLANS.free.aiCreditsPerDay);
    assert.ok(b.remaining <= 10);
});

test('Free hết 10 credits thì bị chặn, nâng lên Pro giữa chu kỳ thì dùng tiếp được phần còn lại của 40', async () => {
    await reserveCredits({ uid: UID, jobId: 'job1', amount: 10, limit: creditLimits(PLANS.free) });
    await settleCredits({ uid: UID, jobId: 'job1', actual: 10 });
    assert.equal((await getBalance(UID, creditLimits(PLANS.free))).remaining, 0);

    const pro = await getBalance(UID, creditLimits(PLANS.pro));
    assert.equal(pro.remaining, 30);
});

test('tạo câu hỏi lỗi thì không trừ credit, thành công 7/10 câu thì chỉ trừ 7', async () => {
    await reserveCredits({ uid: UID, jobId: 'fail', amount: 10, limit: LIMITS });
    await settleCredits({ uid: UID, jobId: 'fail', actual: 0 });
    assert.equal((await getBalance(UID, LIMITS)).remaining, 10);

    await reserveCredits({ uid: UID, jobId: 'ok', amount: 10, limit: LIMITS });
    await settleCredits({ uid: UID, jobId: 'ok', actual: 7 });
    const b = await getBalance(UID, LIMITS);
    assert.equal(b.used, 7);
    assert.equal(b.remaining, 3);
});

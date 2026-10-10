// Chức năng: kiểm thử luồng job tạo câu hỏi trong worker - giữ chỗ khi bắt đầu chạy, chốt khi thành công,
// giải phóng khi thất bại, thử lại có giới hạn, không trừ credits hai lần. Dùng Firestore giả và AI giả (không gọi mạng). Chạy: npm test
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { _setDbForTests } from '../firebase.js';
import { AIError, _setProviderForTests } from '../ai/provider.js';
import { aiCooldown } from '../ai/cooldown.js';
import { getBalance } from '../credits.js';
import { processGenerateQuestions } from '../worker/generateQuestions.js';
import { settleFailure } from '../worker/failure.js';
import { UserError } from '../worker/extract.js';

process.env.AI_PROVIDER = 'fake'; // chọn nhà cung cấp AI giả trong test

// ---------- Firestore giả: đủ cho các thao tác mà worker dùng ----------
function makeFakeDb() {
    const store = new Map(); // "col/id/..." -> dữ liệu
    let auto = 0;
    const clone = (v) => structuredClone(v);
    const parentOf = (p) => p.split('/').slice(0, -1).join('/');
    const idOf = (p) => p.split('/').pop();

    const snapOf = (path) => ({
        id: idOf(path),
        exists: store.has(path),
        ref: refOf(path),
        data: () => (store.has(path) ? clone(store.get(path)) : undefined)
    });

    // Áp dụng cập nhật kiểu Firestore: khóa có dấu chấm là trường lồng, FieldValue.increment cộng dồn
    const applyPatch = (cur, patch) => {
        const out = clone(cur);
        for (const [k, v] of Object.entries(patch)) {
            const parts = k.split('.');
            let obj = out;
            for (const p of parts.slice(0, -1)) {
                if (typeof obj[p] !== 'object' || obj[p] === null) obj[p] = {};
                obj = obj[p];
            }
            const last = parts[parts.length - 1];
            // FieldValue.increment của firebase-admin thật là đối tượng có trường operand (bản stub cũ dùng __inc)
            const inc = v && typeof v === 'object' ? (v.__inc ?? v.operand) : undefined;
            obj[last] = typeof inc === 'number' ? (obj[last] ?? 0) + inc : clone(v);
        }
        return out;
    };

    const refOf = (path) => ({
        path,
        id: idOf(path),
        collection: (sub) => colOf(`${path}/${sub}`),
        get: async () => snapOf(path),
        set: async (data) => {
            store.set(path, clone(data));
        },
        update: async (patch) => {
            if (!store.has(path)) throw Object.assign(new Error('NOT_FOUND'), { code: 5 });
            store.set(path, applyPatch(store.get(path), patch));
        }
    });

    const matches = (data, [field, op, val]) => {
        const v = field.split('.').reduce((o, k) => o?.[k], data);
        if (op === '==') return v === val;
        if (op === 'in') return val.includes(v);
        if (op === '>=') return v >= val;
        if (op === '<=') return v <= val;
        throw new Error(`toán tử ${op} chưa hỗ trợ trong test`);
    };

    const queryOf = (path, filters) => ({
        where: (f, op, v) => queryOf(path, [...filters, [f, op, v]]),
        limit: () => queryOf(path, filters),
        get: async () => {
            const docs = [...store.keys()]
                .filter((k) => parentOf(k) === path && filters.every((f) => matches(store.get(k), f)))
                .map((k) => ({ id: idOf(k), ref: refOf(k), data: () => clone(store.get(k)) }));
            return { docs, size: docs.length, empty: docs.length === 0 };
        }
    });

    const colOf = (path) => ({
        doc: (id) => refOf(`${path}/${id ?? `auto${++auto}`}`),
        ...queryOf(path, [])
    });

    return {
        store,
        collection: (name) => colOf(name),
        getAll: async (...refs) => refs.map((r) => snapOf(r.path)),
        batch() {
            const ops = [];
            const b = {
                set: (ref, data) => {
                    ops.push(() => store.set(ref.path, clone(data)));
                    return b;
                },
                update: (ref, patch) => {
                    ops.push(() => store.set(ref.path, applyPatch(store.get(ref.path), patch)));
                    return b;
                },
                commit: async () => {
                    ops.forEach((op) => op());
                }
            };
            return b;
        },
        runTransaction: async (fn) => {
            const pending = [];
            const tx = {
                get: async (ref) => snapOf(ref.path),
                set: (ref, data, opts) => pending.push({ path: ref.path, data, merge: Boolean(opts?.merge) })
            };
            const result = await fn(tx);
            for (const p of pending) {
                store.set(p.path, p.merge ? { ...(store.get(p.path) ?? {}), ...clone(p.data) } : clone(p.data));
            }
            return result;
        }
    };
}

// ---------- Dữ liệu mẫu và AI giả ----------
const QUESTIONS = [
    {
        type: 'single',
        chunkId: 'c1',
        stem: 'Tính chất nào của phép cộng cho phép đổi chỗ các số hạng?',
        options: ['Giao hoán', 'Lũy thừa', 'Căn bậc hai', 'Đạo hàm'],
        correct: 0,
        explanation: 'Theo tài liệu.'
    },
    {
        type: 'single',
        chunkId: 'c1',
        stem: 'Số 0 đóng vai trò gì khi cộng với một số bất kỳ?',
        options: ['Phần tử trung hòa', 'Phần tử nghịch đảo', 'Số đối', 'Ước chung'],
        correct: 0,
        explanation: 'Theo tài liệu.'
    },
    {
        type: 'single',
        chunkId: 'c1',
        stem: 'Khi cộng nhiều số, ta có thể nhóm các số theo cách nào?',
        options: ['Kết hợp', 'Chia đều', 'Nhân chéo', 'Ngẫu nhiên'],
        correct: 0,
        explanation: 'Theo tài liệu.'
    }
];

let db;
let aiCalls;
let aiBehavior;

beforeEach(() => {
    db = makeFakeDb();
    _setDbForTests(db);
    aiCooldown.reset(); // lỗi 429 giả trong test này không được làm các test sau bị "tạm nghỉ"
    aiCalls = 0;
    aiBehavior = () => ({ data: { questions: QUESTIONS }, usage: { inputTokens: 100, outputTokens: 40 } });
    _setProviderForTests('fake', async () => {
        aiCalls++;
        return aiBehavior();
    });
});

function seed({ balance = null, plan = 'free' } = {}) {
    db.store.set('users/u1', { plan });
    db.store.set('documents/d1', { ownerId: 'u1', status: 'ready' });
    db.store.set('documents/d1/chunks/c1', {
        pageNumber: 1,
        index: 0,
        text: 'Phép cộng có tính giao hoán và kết hợp. Số 0 là phần tử trung hòa của phép cộng.'
    });
    db.store.set('jobs/j1', {
        type: 'generate_questions',
        ownerId: 'u1',
        documentId: 'd1',
        topicId: 't1',
        count: 2,
        types: ['single'],
        status: 'running',
        attempts: 1,
        maxAttempts: 3,
        progress: { done: 0, total: null }
    });
    if (balance) db.store.set('creditBalances/u1', balance);
}

const job = (attempts = 1) => ({
    id: 'j1',
    type: 'generate_questions',
    ownerId: 'u1',
    documentId: 'd1',
    topicId: 't1',
    count: 2,
    types: ['single'],
    attempts,
    maxAttempts: 3,
    pageFrom: null,
    pageTo: null
});

const questionCount = () => [...db.store.keys()].filter((k) => k.startsWith('questions/')).length;
const balance = () => getBalance('u1', 10);
// Timestamp thật sau khi structuredClone chỉ còn _seconds/_nanoseconds (bản stub cũ có trường ms)
const tsMs = (t) => t?.ms ?? (t?._seconds ?? t?.seconds) * 1000 + (t?._nanoseconds ?? t?.nanoseconds ?? 0) / 1e6;
const rateLimited = () => new AIError('AI lỗi 429', { retryable: true, code: 'ai-rate-limit' });

// Chạy job rồi xử lý thất bại nếu có lỗi, giống processJob trong jobRunner
async function runJob(j) {
    try {
        await processGenerateQuestions(j);
    } catch (err) {
        await settleFailure(j, err);
        return err;
    }
    return null;
}

test('thành công: giữ chỗ khi bắt đầu, chốt đúng số câu lưu được, ghi token vào job', async () => {
    seed();
    const err = await runJob(job());
    assert.equal(err, null);
    assert.equal(questionCount(), 2, 'count = 2 nên chỉ lưu 2 câu dù AI trả 3');

    assert.equal(db.store.get('creditLedger/j1_a1_reserved').amount, 2);
    assert.equal(db.store.get('creditLedger/j1_a1_actual').amount, 2);
    assert.equal(db.store.has('creditLedger/j1_a1_refund'), false);

    const b = await balance();
    assert.equal(b.used, 2);
    assert.equal(b.reserved, 0);

    const j = db.store.get('jobs/j1');
    assert.equal(j.status, 'done');
    assert.equal(j.aiUsage.calls, 1);
    assert.equal(j.aiUsage.inputTokens, 100);
    assert.equal(j.aiUsage.outputTokens, 40);
});

test('lỗi AI tạm thời: xếp lại hàng có backoff, giải phóng credits, ghi lỗi lên job', async () => {
    seed();
    aiBehavior = () => {
        throw rateLimited();
    };
    const err = await runJob(job(1));
    assert.ok(err instanceof AIError);

    const j = db.store.get('jobs/j1');
    assert.equal(j.status, 'queued', 'còn lượt thì xếp lại hàng, không thất bại hẳn');
    assert.ok(j.runAfter, 'có thời điểm chạy lại (backoff)');
    assert.equal(j.failures, 1);
    assert.equal(j.lastError.code, 'ai-rate-limit');
    assert.equal(j.lastError.attempt, 1);

    const b = await balance();
    assert.equal(b.reserved, 0, 'job đang chờ backoff không được giữ credits');
    assert.equal(b.used, 0);
    assert.equal(db.store.get('creditLedger/j1_a1_refund').amount, 2);
    assert.equal(questionCount(), 0);
});

test('hết lượt thử lại: thất bại hẳn và đưa vào dead-letter', async () => {
    seed();
    aiBehavior = () => {
        throw rateLimited();
    };
    await runJob(job(3));

    const j = db.store.get('jobs/j1');
    assert.equal(j.status, 'failed');
    assert.equal(j.deadLetter, true);
    assert.equal((await balance()).reserved, 0);
});

test('hết credits khi bắt đầu chạy: không gọi AI, thất bại ngay, không thử lại', async () => {
    seed({ balance: { cycleStart: Date.now(), used: 10, reserved: 0 } }); // gói free = 10 credits / 24 giờ, đã dùng hết
    const err = await runJob(job(1));
    assert.ok(err instanceof UserError);
    assert.equal(err.code, 'quota-credits');
    assert.equal(aiCalls, 0, 'không được gọi AI khi không đủ credits');

    const j = db.store.get('jobs/j1');
    assert.equal(j.status, 'failed');
    assert.equal(j.deadLetter, false);
    assert.equal(db.store.has('creditLedger/j1_a1_reserved'), false, 'không có gì để giữ');
});

test('AI không trả câu hợp lệ: thất bại ngay với thông báo cho người dùng, không gọi AI lại', async () => {
    seed();
    aiBehavior = () => ({ data: { questions: [{ ...QUESTIONS[0], chunkId: 'khong-ton-tai' }] }, usage: { inputTokens: 5, outputTokens: 5 } });
    const err = await runJob(job(1));
    assert.ok(err instanceof UserError);
    assert.equal(aiCalls, 1, 'không thử lại khi AI trả về không hợp lệ');

    const j = db.store.get('jobs/j1');
    assert.equal(j.status, 'failed');
    assert.equal(j.deadLetter, false);
    assert.match(j.error, /AI không tạo được câu hỏi hợp lệ/);
    assert.equal((await balance()).reserved, 0);
    assert.equal(db.store.get('creditLedger/j1_a1_refund').amount, 2);
});

test('chạy lại cùng một lần thử không trừ credits hai lần', async () => {
    seed();
    await runJob(job(1));
    await runJob(job(1)); // giả lập worker chạy lại sau khi đã lưu xong nhưng chưa kịp ghi trạng thái
    assert.equal((await balance()).used, 2);
    assert.equal((await balance()).reserved, 0);
});

test('lỗi lập trình (không có mã lỗi) không được thử lại nhưng vẫn giải phóng credits', async () => {
    seed();
    aiBehavior = () => {
        throw new TypeError('lỗi lập trình giả');
    };
    await runJob(job(1));

    const j = db.store.get('jobs/j1');
    assert.equal(j.status, 'failed');
    assert.equal(j.deadLetter, false);
    assert.equal((await balance()).reserved, 0);
    assert.equal(aiCalls, 1);
});

test('mỗi lần thử có khóa giữ chỗ riêng: lần thử thứ hai không bị tính chung với lần đầu', async () => {
    seed();
    aiBehavior = () => {
        throw rateLimited();
    };
    await runJob(job(1)); // lần 1 thất bại tạm thời, giải phóng
    aiCooldown.reset(); // giả lập đã hết thời gian tạm nghỉ sau lỗi 429
    aiBehavior = () => ({ data: { questions: QUESTIONS }, usage: { inputTokens: 1, outputTokens: 1 } });
    await runJob(job(2)); // lần 2 thành công

    assert.equal(db.store.get('creditLedger/j1_a2_actual').amount, 2);
    const b = await balance();
    assert.equal(b.used, 2);
    assert.equal(b.reserved, 0);
});

test('429 kèm thời gian chờ lâu: job được hẹn chạy lại không sớm hơn Gemini yêu cầu, hệ thống tạm nghỉ', async () => {
    seed();
    aiBehavior = () => {
        throw new AIError('AI lỗi 429', { retryable: true, code: 'ai-rate-limit', retryAfterMs: 5 * 60_000 });
    };
    const before = Date.now();
    await runJob(job(1));

    const j = db.store.get('jobs/j1');
    assert.equal(j.status, 'queued');
    assert.ok(tsMs(j.runAfter) - before >= 5 * 60_000 - 50, 'phải chờ ít nhất 5 phút, dù backoff lần 1 chỉ 30 giây');
    assert.ok(aiCooldown.remainingMs() > 4 * 60_000);
    assert.equal((await balance()).reserved, 0);
});

test('hết quota trong ngày: job thất bại ngay, không thử lại, hoàn credits, hệ thống tạm nghỉ', async () => {
    seed();
    aiBehavior = () => {
        throw new AIError('Gemini đã hết hạn mức trong ngày', { code: 'ai-quota-daily', retryAfterMs: 30 * 60_000 });
    };
    await runJob(job(1));

    const j = db.store.get('jobs/j1');
    assert.equal(j.status, 'failed');
    assert.equal(j.deadLetter, false);
    assert.equal(aiCalls, 1);
    assert.equal((await balance()).reserved, 0);
    assert.equal(db.store.get('creditLedger/j1_a1_refund').amount, 2);
    assert.ok(aiCooldown.remainingMs() > 25 * 60_000);
});

test('đang tạm nghỉ: job không gọi Gemini, được xếp lại và credits được giải phóng', async () => {
    seed();
    aiCooldown.start(2 * 60_000);
    await runJob(job(1));

    assert.equal(aiCalls, 0, 'không được gửi request nào lên Gemini');
    const j = db.store.get('jobs/j1');
    assert.equal(j.status, 'queued');
    assert.equal(j.lastError.code, 'ai-cooldown');
    assert.equal((await balance()).reserved, 0);
});

// Chức năng: kiểm thử luật làm bài (không gọi mạng/DB): xáo trộn theo seed, đề không lộ đáp án, làm sạch câu trả lời, chấm điểm, hạn nộp. Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    GRACE_MS,
    arrange,
    buildAttemptView,
    buildReview,
    cleanAnswer,
    cleanAnswers,
    computeDeadline,
    gradeAttempt,
    isPastDeadline,
    mergeAnswers,
    normalizeFill,
    seededShuffle
} from '../quiz/gradingRules.js';

const questions = [
    { id: 'q1', type: 'single', stem: 'Câu 1', options: ['A', 'B', 'C', 'D'], explanation: 'giải thích bí mật' },
    { id: 'q2', type: 'multi', stem: 'Câu 2', options: ['A', 'B', 'C', 'D'], explanation: '' },
    { id: 'q3', type: 'truefalse', stem: 'Câu 3', options: ['Đúng', 'Sai'], explanation: '' },
    { id: 'q4', type: 'fill', stem: 'Câu 4 ____', options: [], explanation: '' },
    { id: 'q5', type: 'short', stem: 'Câu 5', options: [], explanation: '' }
];
const keys = {
    q1: { type: 'single', correct: 2 },
    q2: { type: 'multi', correct: [0, 3] },
    q3: { type: 'truefalse', correct: true },
    q4: { type: 'fill', correct: '0,5', alternatives: ['1/2'] },
    q5: { type: 'short', correct: 'Đáp án mẫu' }
};
const byId = (id) => questions.find((q) => q.id === id);
const SHUFFLE_ALL = { shuffleQuestions: true, shuffleOptions: true };
const SHUFFLE_NONE = { shuffleQuestions: false, shuffleOptions: false };

// ---------- Xáo trộn ----------
test('xáo trộn theo seed: cùng seed cùng kết quả, là hoán vị, không sửa mảng gốc', () => {
    const list = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = seededShuffle(list, 123);
    assert.deepEqual(a, seededShuffle(list, 123));
    assert.deepEqual([...a].sort((x, y) => x - y), list);
    assert.deepEqual(list, [1, 2, 3, 4, 5, 6, 7, 8]);
    const moved = Array.from({ length: 20 }, (_, i) => seededShuffle(list, i + 1)).some((s) => s.join() !== list.join());
    assert.equal(moved, true);
});

test('đề gửi cho người làm không có đáp án, giải thích hay nguồn', () => {
    const view = buildAttemptView(questions, SHUFFLE_ALL, 42);
    assert.equal(view.length, 5);
    for (const v of view) assert.deepEqual(Object.keys(v).sort(), ['id', 'options', 'stem', 'type']);
    const text = JSON.stringify(view);
    assert.equal(text.includes('bí mật'), false);
    assert.equal(text.includes('correct'), false);
});

test('xáo trộn đáp án vẫn giữ index gốc của từng đáp án', () => {
    const view = buildAttemptView(questions, SHUFFLE_ALL, 7);
    for (const v of view) {
        for (const o of v.options) assert.equal(o.text, byId(v.id).options[o.index]);
    }
});

test('đúng/sai không bị xáo trộn đáp án', () => {
    for (let seed = 1; seed <= 10; seed++) {
        const v = buildAttemptView(questions, SHUFFLE_ALL, seed).find((x) => x.id === 'q3');
        assert.deepEqual(v.options.map((o) => o.index), [0, 1]);
    }
});

test('tắt xáo trộn thì giữ nguyên thứ tự câu và đáp án', () => {
    const view = buildAttemptView(questions, SHUFFLE_NONE, 99);
    assert.deepEqual(view.map((v) => v.id), ['q1', 'q2', 'q3', 'q4', 'q5']);
    assert.deepEqual(view[0].options.map((o) => o.index), [0, 1, 2, 3]);
});

test('cùng seed luôn dựng lại đúng đề (tải lại trang, reconnect)', () => {
    assert.deepEqual(buildAttemptView(questions, SHUFFLE_ALL, 555), buildAttemptView(questions, SHUFFLE_ALL, 555));
    assert.equal(arrange(questions, SHUFFLE_ALL, 555).length, 5);
});

// ---------- Làm sạch câu trả lời ----------
test('cleanAnswer: một đáp án', () => {
    const q = byId('q1');
    assert.deepEqual(cleanAnswer(q, 2), { ok: true, value: 2 });
    assert.equal(cleanAnswer(q, 4).ok, false);
    assert.equal(cleanAnswer(q, -1).ok, false);
    assert.equal(cleanAnswer(q, '2').ok, false);
    assert.equal(cleanAnswer(q, 1.5).ok, false);
    assert.deepEqual(cleanAnswer(q, null), { ok: true, value: null });
});

test('cleanAnswer: nhiều đáp án được sắp xếp, loại trùng', () => {
    const q = byId('q2');
    assert.deepEqual(cleanAnswer(q, [3, 0, 3]), { ok: true, value: [0, 3] });
    assert.deepEqual(cleanAnswer(q, []), { ok: true, value: null });
    assert.equal(cleanAnswer(q, [9]).ok, false);
    assert.equal(cleanAnswer(q, 'a').ok, false);
});

test('cleanAnswer: đúng/sai chỉ nhận true hoặc false', () => {
    const q = byId('q3');
    assert.deepEqual(cleanAnswer(q, false), { ok: true, value: false });
    assert.equal(cleanAnswer(q, 'true').ok, false);
});

test('cleanAnswer: điền khuyết và trả lời ngắn có giới hạn độ dài', () => {
    assert.deepEqual(cleanAnswer(byId('q4'), '  abc '), { ok: true, value: 'abc' });
    assert.deepEqual(cleanAnswer(byId('q4'), '   '), { ok: true, value: null });
    assert.equal(cleanAnswer(byId('q4'), 'x'.repeat(201)).ok, false);
    assert.equal(cleanAnswer(byId('q4'), 5).ok, false);
    assert.equal(cleanAnswer(byId('q5'), 'x'.repeat(300)).ok, true);
    assert.equal(cleanAnswer(byId('q5'), 'x'.repeat(301)).ok, false);
});

test('cleanAnswers loại câu không thuộc đề và câu sai dạng', () => {
    const { answers, rejected } = cleanAnswers(questions, { q1: 1, q2: [1, 2], zzz: 1, q3: 'x' });
    assert.deepEqual(answers, { q1: 1, q2: [1, 2] });
    assert.deepEqual(rejected.sort(), ['q3', 'zzz']);
});

test('mergeAnswers: null xóa câu trả lời, giá trị mới ghi đè', () => {
    const merged = mergeAnswers({ q1: 1, q2: [0] }, { q1: 3, q2: null, q3: true });
    assert.deepEqual(merged, { q1: 3, q3: true });
});

// ---------- Chấm điểm ----------
test('chấm đủ: trả lời ngắn không tính vào điểm', () => {
    const r = gradeAttempt(questions, keys, { q1: 2, q2: [3, 0], q3: true, q4: '0.5', q5: 'bất kỳ' });
    assert.equal(r.correct, 4);
    assert.equal(r.wrong, 0);
    assert.equal(r.unanswered, 0);
    assert.equal(r.pending, 1);
    assert.equal(r.gradable, 4);
    assert.equal(r.total, 5);
    assert.equal(r.percent, 100);
    assert.equal(r.score10, 10);
    assert.equal(r.statuses.q5, 'pending');
});

test('nhiều đáp án: thiếu hoặc thừa một đáp án đều sai', () => {
    assert.equal(gradeAttempt(questions, keys, { q2: [0] }).statuses.q2, 'wrong');
    assert.equal(gradeAttempt(questions, keys, { q2: [0, 1, 3] }).statuses.q2, 'wrong');
    assert.equal(gradeAttempt(questions, keys, { q2: [0, 3] }).statuses.q2, 'correct');
});

test('điền khuyết: bỏ qua hoa thường, khoảng trắng, dấu câu cuối, dấu phẩy thập phân, và nhận đáp án thay thế', () => {
    const grade = (v) => gradeAttempt(questions, keys, { q4: v }).statuses.q4;
    assert.equal(grade(' 0,5. '), 'correct');
    assert.equal(grade('0.5'), 'correct');
    assert.equal(grade('1/2'), 'correct');
    assert.equal(grade('abc'), 'wrong');
    assert.equal(normalizeFill('  Hà   Nội. '), 'hà nội');
});

test('câu bỏ trống được tính là chưa trả lời, điểm là 0', () => {
    const r = gradeAttempt(questions, keys, {});
    assert.equal(r.unanswered, 4);
    assert.equal(r.correct, 0);
    assert.equal(r.statuses.q5, 'unanswered');
    assert.equal(r.pending, 0);
    assert.equal(r.percent, 0);
    assert.equal(r.score10, 0);
});

test('điểm làm tròn 2 chữ số theo thang 10', () => {
    const three = questions.slice(0, 1).concat(questions.slice(2, 3), questions.slice(3, 4));
    const r = gradeAttempt(three, keys, { q1: 2, q3: true, q4: 'sai' });
    assert.equal(r.correct, 2);
    assert.equal(r.percent, 67);
    assert.equal(r.score10, 6.67);
});

test('quiz chỉ có câu trả lời ngắn: không có điểm tự chấm', () => {
    const r = gradeAttempt([byId('q5')], keys, { q5: 'abc' });
    assert.equal(r.gradable, 0);
    assert.equal(r.percent, null);
    assert.equal(r.score10, null);
    assert.equal(r.pending, 1);
});

// ---------- Xem lại ----------
test('bản xem lại có đáp án đúng, câu trả lời đã chọn và trạng thái', () => {
    const answers = { q1: 1 };
    const { statuses } = gradeAttempt(questions, keys, answers);
    const review = buildReview({ questions, settings: SHUFFLE_NONE, seed: 1, keys, answers, statuses });
    assert.equal(review[0].given, 1);
    assert.equal(review[0].correct, 2);
    assert.equal(review[0].status, 'wrong');
    assert.equal(review[0].explanation, 'giải thích bí mật');
    assert.equal(review[2].correct, true);
    assert.equal(review[2].status, 'unanswered');
});

test('đáp án đúng là false vẫn được giữ (không bị đổi thành null)', () => {
    const review = buildReview({
        questions: [byId('q3')],
        settings: SHUFFLE_NONE,
        seed: 1,
        keys: { q3: { type: 'truefalse', correct: false } },
        answers: {},
        statuses: {}
    });
    assert.equal(review[0].correct, false);
});

// ---------- Giờ làm bài ----------
test('hạn nộp: không giới hạn thời gian thì không bao giờ quá hạn', () => {
    assert.equal(computeDeadline(1000, null), null);
    assert.equal(isPastDeadline(null, 9e15), false);
});

test('hạn nộp: có dung sai mạng sau mốc hết giờ', () => {
    const deadline = computeDeadline(1000, 10);
    assert.equal(deadline, 1000 + 600_000);
    assert.equal(isPastDeadline(deadline, deadline), false);
    assert.equal(isPastDeadline(deadline, deadline + GRACE_MS), false);
    assert.equal(isPastDeadline(deadline, deadline + GRACE_MS + 1), true);
});

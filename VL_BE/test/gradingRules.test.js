// Chức năng: kiểm thử luật làm bài (không gọi mạng/DB): xáo trộn theo seed, đề không lộ đáp án, làm sạch câu trả lời, chấm điểm, hạn nộp. Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    GRACE_MS,
    LONG_THINK_MS,
    arrange,
    buildAttemptView,
    buildReview,
    carelessLimitMs,
    classifyError,
    classifyErrors,
    cleanAnswer,
    cleanAnswers,
    cleanConfidence,
    cleanSpent,
    computeDeadline,
    countChanges,
    gradeAttempt,
    isPastDeadline,
    mergeAnswers,
    mergeSpent,
    normalizeFill,
    pruneConfidence,
    seededShuffle,
    summarizeConfidence,
    summarizeTopics,
    textLengthOf
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

// ---------- Mức tự tin + đổi đáp án (Phase 5) ----------
test('cleanConfidence: chỉ nhận 3 mức, null để xóa, loại câu không thuộc đề', () => {
    const { confidence, rejected } = cleanConfidence(questions, { q1: 'sure', q2: 'guess', q3: null, q4: 'maybe', zzz: 'sure' });
    assert.deepEqual(confidence, { q1: 'sure', q2: 'guess', q3: null });
    assert.deepEqual(rejected.sort(), ['q4', 'zzz']);
});

test('pruneConfidence: bỏ mức tự tin của câu không còn câu trả lời', () => {
    assert.deepEqual(pruneConfidence({ q1: 'sure', q2: 'guess' }, { q1: 0 }), { q1: 'sure' });
    assert.deepEqual(pruneConfidence({ q1: 'sure' }, { q1: false }), { q1: 'sure' });
    assert.deepEqual(pruneConfidence(undefined, {}), {});
});

test('countChanges: chỉ đếm khi câu đã lưu và giá trị mới khác', () => {
    const saved = { q1: 1, q2: [0, 3] };
    assert.deepEqual(countChanges({}, saved, { q1: 2 }), { q1: 1 });
    assert.deepEqual(countChanges({ q1: 1 }, saved, { q1: 3 }), { q1: 2 });
    assert.deepEqual(countChanges({}, saved, { q1: 1, q2: [0, 3] }), {});
    assert.deepEqual(countChanges({}, saved, { q1: null, q3: true }), {});
    assert.deepEqual(countChanges({}, saved, { q2: [1] }), { q2: 1 });
    const typed = [{ id: 'f', type: 'fill' }, { id: 's', type: 'short' }, { id: 'q1', type: 'single' }];
    assert.deepEqual(countChanges({}, { f: 'ab', s: 'x', q1: 1 }, { f: 'abc', s: 'xy', q1: 2 }, typed), { q1: 1 });
});

test('summarizeConfidence: chỉ tính câu đã chấm, đếm chắc chắn nhưng sai và đoán trúng', () => {
    const statuses = { q1: 'wrong', q2: 'correct', q3: 'correct', q4: 'unanswered', q5: 'pending' };
    const s = summarizeConfidence(statuses, { q1: 'sure', q2: 'guess', q3: 'sure', q4: 'unsure', q5: 'sure' });
    assert.equal(s.rated, 3);
    assert.deepEqual(s.levels.sure, { correct: 1, wrong: 1 });
    assert.deepEqual(s.levels.guess, { correct: 1, wrong: 0 });
    assert.deepEqual(s.levels.unsure, { correct: 0, wrong: 0 });
    assert.equal(s.sureWrong, 1);
    assert.equal(s.guessCorrect, 1);
});

test('summarizeTopics: gộp theo chủ đề, bỏ câu trả lời ngắn, chủ đề yếu nhất lên đầu', () => {
    const qs = [
        { id: 'a', type: 'single', topicId: 't1' },
        { id: 'b', type: 'single', topicId: 't1' },
        { id: 'c', type: 'fill', topicId: 't2' },
        { id: 'd', type: 'short', topicId: 't2' },
        { id: 'e', type: 'truefalse', topicId: 't2' }
    ];
    const statuses = { a: 'correct', b: 'wrong', c: 'wrong', d: 'pending', e: 'unanswered' };
    const info = { t1: { subject: 'Toán', chapter: 'Chương 1', name: 'Hàm số' } };
    const out = summarizeTopics(qs, statuses, info);
    assert.equal(out.length, 2);
    assert.equal(out[0].topicId, 't2');
    assert.deepEqual([out[0].correct, out[0].wrong, out[0].unanswered, out[0].total], [0, 1, 1, 2]);
    assert.equal(out[0].name, null);
    assert.equal(out[1].name, 'Hàm số');
    assert.equal(out[1].subject, 'Toán');
});

test('bản xem lại có mức tự tin, số lần đổi và chủ đề', () => {
    const qs = [{ ...byId('q1'), topicId: 't1' }];
    const review = buildReview({
        questions: qs,
        settings: SHUFFLE_NONE,
        seed: 1,
        keys,
        answers: { q1: 2 },
        statuses: { q1: 'correct' },
        confidence: { q1: 'sure' },
        changes: { q1: 2 }
    });
    assert.equal(review[0].topicId, 't1');
    assert.equal(review[0].confidence, 'sure');
    assert.equal(review[0].changes, 2);
    const bare = buildReview({ questions: qs, settings: SHUFFLE_NONE, seed: 1, keys, answers: {}, statuses: {} });
    assert.equal(bare[0].confidence, null);
    assert.equal(bare[0].changes, 0);
});

// ---------- Thời gian + gợi ý kiểu sai (Phase 5) ----------
test('cleanSpent: chỉ nhận số không âm của câu thuộc đề, cắt trần 1 giờ', () => {
    const out = cleanSpent(questions, { q1: 1234.6, q2: -5, q3: 'x', zzz: 10, q4: 99_999_999 });
    assert.deepEqual(out, { q1: 1235, q4: 3_600_000 });
});

test('mergeSpent: giữ giá trị lớn hơn', () => {
    assert.deepEqual(mergeSpent({ q1: 5000, q2: 100 }, { q1: 3000, q2: 900, q3: 50 }), { q1: 5000, q2: 900, q3: 50 });
});

test('classifyError: thứ tự ưu tiên hết giờ, đoán, ẩu, hiểu nhầm, lưỡng lự, thiếu kiến thức, chưa rõ', () => {
    const base = { status: 'wrong', type: 'single', confidence: null, changes: 0, spentMs: 20_000, submitReason: 'submitted' };
    assert.equal(classifyError({ ...base, status: 'unanswered', submitReason: 'timeout' }), 'timeout');
    assert.equal(classifyError({ ...base, status: 'unanswered', submitReason: 'room-ended' }), 'timeout');
    assert.equal(classifyError({ ...base, status: 'unanswered' }), null);
    assert.equal(classifyError({ ...base, confidence: 'guess', spentMs: 1000, changes: 2 }), 'guess');
    assert.equal(classifyError({ ...base, spentMs: 2999, changes: 2, confidence: 'unsure' }), 'careless');
    assert.equal(classifyError({ ...base, confidence: 'sure' }), 'misconception');
    assert.equal(classifyError({ ...base, changes: 2 }), 'changed');
    assert.equal(classifyError({ ...base, confidence: 'unsure' }), 'knowledge');
});

test('classifyError: "Chắc chắn" mà sai được coi là hiểu nhầm kể cả khi trả lời nhanh hoặc đổi đáp án', () => {
    const base = { status: 'wrong', type: 'single', confidence: 'sure', changes: 0, spentMs: 20_000 };
    assert.equal(classifyError({ ...base, spentMs: 1500 }), 'misconception');
    assert.equal(classifyError({ ...base, changes: 3 }), 'misconception');
});

test('classifyError: không có tín hiệu nào thì trả "unknown", không đoán là thiếu kiến thức', () => {
    const base = { status: 'wrong', type: 'single', confidence: null, changes: 0, spentMs: 20_000 };
    assert.equal(classifyError(base), 'unknown');
    assert.equal(classifyError({ ...base, spentMs: 3000 }), 'unknown');
    assert.equal(classifyError({ ...base, spentMs: null }), 'unknown');
    assert.equal(classifyError({ ...base, changes: 1 }), 'unknown'); // đổi đáp án 1 lần là bình thường
});

test('classifyError: nghĩ lâu mà vẫn sai là dấu hiệu thiếu kiến thức', () => {
    const base = { status: 'wrong', type: 'single', confidence: null, changes: 0 };
    assert.equal(classifyError({ ...base, spentMs: LONG_THINK_MS }), 'knowledge');
    assert.equal(classifyError({ ...base, spentMs: LONG_THINK_MS - 1 }), 'unknown');
});

test('carelessLimitMs: đề càng dài thì ngưỡng ẩu càng cao, có sàn 3 giây và trần 10 giây', () => {
    assert.equal(carelessLimitMs(0), 3000);
    assert.equal(carelessLimitMs(50), 3000);
    assert.equal(carelessLimitMs(300), 8824);
    assert.equal(carelessLimitMs(5000), 10_000);
    const base = { status: 'wrong', type: 'single', confidence: null, changes: 0, spentMs: 6000 };
    assert.equal(classifyError({ ...base, textLength: 300 }), 'careless'); // 6 giây là quá nhanh cho đề 300 ký tự
    assert.equal(classifyError({ ...base, textLength: 50 }), 'unknown'); // nhưng là bình thường cho đề ngắn
});

test('textLengthOf: tính cả đề và các lựa chọn, nhận cả chuỗi lẫn { text }', () => {
    assert.equal(textLengthOf({ stem: 'abcd', options: ['ab', 'cde'] }), 9);
    assert.equal(textLengthOf({ stem: 'abcd', options: [{ index: 0, text: 'ab' }] }), 6);
    assert.equal(textLengthOf({}), 0);
});

test('classifyError: câu đúng, tự đối chiếu, trả lời ngắn không bị phân loại', () => {
    assert.equal(classifyError({ status: 'correct', type: 'single' }), null);
    assert.equal(classifyError({ status: 'pending', type: 'short' }), null);
    assert.equal(classifyError({ status: 'unanswered', type: 'short', submitReason: 'timeout' }), null);
});

test('classifyErrors: phân loại cả lượt và đếm theo loại', () => {
    const statuses = { q1: 'wrong', q2: 'wrong', q3: 'correct', q4: 'unanswered', q5: 'pending' };
    const out = classifyErrors({
        questions,
        statuses,
        confidence: { q1: 'sure', q2: 'guess' },
        changes: {},
        spent: { q1: 15_000, q2: 8000 },
        submitReason: 'timeout'
    });
    assert.deepEqual(out.byQuestion, { q1: 'misconception', q2: 'guess', q4: 'timeout' });
    assert.equal(out.summary.misconception, 1);
    assert.equal(out.summary.guess, 1);
    assert.equal(out.summary.timeout, 1);
    assert.equal(out.summary.knowledge, 0);
    assert.equal(out.summary.unknown, 0);
});

test('bản xem lại có thời gian và gợi ý kiểu sai', () => {
    const review = buildReview({
        questions: [byId('q1')],
        settings: SHUFFLE_NONE,
        seed: 1,
        keys,
        answers: { q1: 1 },
        statuses: { q1: 'wrong' },
        spent: { q1: 7000 },
        errorTypes: { q1: 'knowledge' }
    });
    assert.equal(review[0].spentMs, 7000);
    assert.equal(review[0].errorType, 'knowledge');
});

// Chức năng: kiểm thử chế độ nhanh của phòng (khởi động, exit ticket): cấu hình, chọn tập câu theo seed, chấm đúng tập đã chọn. Không gọi mạng/DB. Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { ROOM_MODES, roomModeConfig } from '../quiz/roomRules.js';
import { buildAttemptView, cleanAnswers, gradeAttempt, pickQuestionIds, questionsForAttempt } from '../quiz/gradingRules.js';

const makeQuestions = (n) =>
    Array.from({ length: n }, (_, i) => ({ id: `q${i + 1}`, type: 'single', stem: `Câu ${i + 1}`, options: ['A', 'B', 'C', 'D'] }));

const keysOf = (questions) => Object.fromEntries(questions.map((q, i) => [q.id, { type: 'single', correct: i % 4 }]));

test('phòng bình thường giữ cài đặt thời gian của quiz', () => {
    assert.deepEqual(roomModeConfig('standard', 20, 15), { mode: 'standard', questionLimit: null, timeLimitMinutes: 15 });
    assert.deepEqual(roomModeConfig(undefined, 20), { mode: 'standard', questionLimit: null, timeLimitMinutes: null });
    assert.equal(roomModeConfig('khong-co', 20, 10).mode, 'standard');
});

test('khởi động và exit ticket ghi đè số câu và thời gian, bỏ qua cài đặt của quiz', () => {
    assert.deepEqual(roomModeConfig('warmup', 20, 60), { mode: 'warmup', questionLimit: 5, timeLimitMinutes: 5 });
    assert.deepEqual(roomModeConfig('exit', 20, null), { mode: 'exit', questionLimit: 3, timeLimitMinutes: 3 });
    assert.ok(ROOM_MODES.warmup.questionLimit > ROOM_MODES.exit.questionLimit);
});

test('quiz ít câu hơn mức của chế độ nhanh thì lấy hết số câu đang có', () => {
    assert.equal(roomModeConfig('warmup', 4).questionLimit, 4);
    assert.equal(roomModeConfig('exit', 2).questionLimit, 2);
});

test('chọn tập câu: đúng số lượng, không trùng, thuộc quiz', () => {
    const qs = makeQuestions(20);
    const ids = pickQuestionIds(qs, 5, 12345);
    assert.equal(ids.length, 5);
    assert.equal(new Set(ids).size, 5);
    assert.ok(ids.every((id) => qs.some((q) => q.id === id)));
});

test('cùng seed thì cùng tập câu (tải lại trang không đổi đề), khác seed thì phần lớn khác nhau', () => {
    const qs = makeQuestions(20);
    assert.deepEqual(pickQuestionIds(qs, 5, 777), pickQuestionIds(qs, 5, 777));
    const distinct = new Set();
    for (let seed = 1; seed <= 30; seed++) distinct.add(pickQuestionIds(qs, 5, seed).slice().sort().join(','));
    assert.ok(distinct.size > 20, `chỉ có ${distinct.size} tập khác nhau trong 30 seed`);
});

test('không giới hạn hoặc giới hạn >= số câu thì dùng đủ câu (null)', () => {
    const qs = makeQuestions(5);
    assert.equal(pickQuestionIds(qs, null, 1), null);
    assert.equal(pickQuestionIds(qs, undefined, 1), null);
    assert.equal(pickQuestionIds(qs, 5, 1), null);
    assert.equal(pickQuestionIds(qs, 9, 1), null);
    assert.equal(pickQuestionIds(qs, 0, 1), null);
});

test('questionsForAttempt giữ thứ tự gốc của version', () => {
    const qs = makeQuestions(10);
    const subset = questionsForAttempt(qs, ['q9', 'q2', 'q5']);
    assert.deepEqual(
        subset.map((q) => q.id),
        ['q2', 'q5', 'q9']
    );
    assert.equal(questionsForAttempt(qs, null), qs);
});

test('đề gửi người làm chỉ có đúng các câu đã chọn', () => {
    const qs = makeQuestions(12);
    const ids = pickQuestionIds(qs, 3, 4242);
    const view = buildAttemptView(questionsForAttempt(qs, ids), { shuffleQuestions: true, shuffleOptions: true }, 4242);
    assert.equal(view.length, 3);
    assert.deepEqual(view.map((v) => v.id).sort(), [...ids].sort());
});

test('chấm chỉ tính các câu trong tập đã chọn', () => {
    const qs = makeQuestions(12);
    const keys = keysOf(qs);
    const ids = pickQuestionIds(qs, 3, 99);
    const subset = questionsForAttempt(qs, ids);

    const allRight = Object.fromEntries(subset.map((q) => [q.id, keys[q.id].correct]));
    const full = gradeAttempt(subset, keys, allRight);
    assert.equal(full.total, 3);
    assert.equal(full.gradable, 3);
    assert.equal(full.correct, 3);
    assert.equal(full.percent, 100);

    // Bỏ trống thì chỉ tính 3 câu bỏ qua, không phải 12
    const none = gradeAttempt(subset, keys, {});
    assert.equal(none.unanswered, 3);
    assert.equal(none.total, 3);
});

test('câu trả lời cho câu ngoài tập đã chọn bị từ chối', () => {
    const qs = makeQuestions(12);
    const ids = pickQuestionIds(qs, 3, 5);
    const subset = questionsForAttempt(qs, ids);
    const outside = qs.find((q) => !ids.includes(q.id));

    const { answers, rejected } = cleanAnswers(subset, { [subset[0].id]: 1, [outside.id]: 2 });
    assert.deepEqual(Object.keys(answers), [subset[0].id]);
    assert.deepEqual(rejected, [outside.id]);
});

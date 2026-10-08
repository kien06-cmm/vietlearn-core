// Chức năng: kiểm thử luật Quiz (không gọi mạng/DB): cài đặt, băm nội dung, snapshot không lộ đáp án. Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, dedupeIds, draftHash, hashOf, mergeSettings, rawOf } from '../quiz/quizRules.js';
import { parseQuestion } from '../ai/questionRules.js';

const item = (id, over = {}) => ({
    id,
    q: {
        type: 'single',
        topicId: 't1',
        stem: 'Thủ đô của nước Việt Nam là thành phố nào?',
        options: ['Hà Nội', 'Huế', 'Đà Nẵng', 'Cần Thơ'],
        explanation: '',
        source: { documentId: 'd1', pageNumber: 2, chunkId: 'c1' },
        ...over
    },
    key: { type: 'single', correct: 0 }
});

test('cài đặt mặc định khi chưa có gì', () => {
    assert.deepEqual(mergeSettings(null, null), {
        timeLimitMinutes: null,
        maxAttempts: null,
        shuffleQuestions: true,
        shuffleOptions: true
    });
});

test('gộp cài đặt: chỉ đổi phần được gửi', () => {
    const base = mergeSettings(null, { timeLimitMinutes: 20 });
    const next = mergeSettings(base, { maxAttempts: 2 });
    assert.equal(next.timeLimitMinutes, 20);
    assert.equal(next.maxAttempts, 2);
});

test('đặt lại về không giới hạn bằng null', () => {
    const base = mergeSettings(null, { timeLimitMinutes: 20 });
    assert.equal(mergeSettings(base, { timeLimitMinutes: null }).timeLimitMinutes, null);
});

test('băm ổn định và đổi khi nội dung đổi', () => {
    const a = draftHash({ title: 'A', questionIds: ['1', '2'], settings: mergeSettings() });
    const b = draftHash({ title: 'A', questionIds: ['1', '2'], settings: mergeSettings() });
    const c = draftHash({ title: 'A', questionIds: ['2', '1'], settings: mergeSettings() });
    assert.equal(a, b);
    assert.notEqual(a, c);
    assert.notEqual(hashOf({ x: 1 }), hashOf({ x: 2 }));
});

test('loại id trùng, giữ thứ tự', () => {
    assert.deepEqual(dedupeIds(['b', 'a', 'b', 'c', 'a']), ['b', 'a', 'c']);
});

test('snapshot tách đáp án ra khỏi phần hiển thị', () => {
    const { questions, keys } = buildSnapshot([item('q1'), item('q2')]);
    assert.equal(questions.length, 2);
    assert.equal('correct' in questions[0], false);
    assert.equal('answer' in questions[0], false);
    assert.equal(keys.q1.correct, 0);
});

test('snapshot giữ thứ tự câu hỏi', () => {
    const { questions } = buildSnapshot([item('q2'), item('q1')]);
    assert.deepEqual(
        questions.map((q) => q.id),
        ['q2', 'q1']
    );
});

test('rawOf dựng lại câu hợp lệ cho parseQuestion', () => {
    const { q, key } = item('q1');
    assert.equal(parseQuestion(rawOf(q, key)).ok, true);
});

test('rawOf phát hiện câu bị hỏng đáp án', () => {
    const { q } = item('q1');
    const r = parseQuestion(rawOf(q, { type: 'single', correct: 9 }));
    assert.equal(r.ok, false);
});

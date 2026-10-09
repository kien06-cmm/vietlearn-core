// Chức năng: kiểm thử luật vòng lặp học tập (không gọi mạng/DB): đáp án nhiễu, ghi câu sai, lịch ôn 1-3-7, dạng gửi cho giao diện. Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MASTERED_STAGE,
    REVIEW_INTERVALS_DAYS,
    applyReview,
    applyWrong,
    nextStage,
    summarizeMistakes,
    toListItem,
    toReviewQuestion,
    topWrongOption,
    wrongPicks
} from '../quiz/learningRules.js';

const NOW = Date.UTC(2026, 9, 9, 8, 0, 0);
const DAY = 86_400_000;
const incoming = {
    questionId: 'q1',
    quizId: 'z1',
    quizVersion: 2,
    topicId: 't1',
    type: 'single',
    stem: 'Câu 1',
    options: ['A', 'B', 'C', 'D'],
    correct: 2,
    explanation: 'vì C',
    errorType: 'misconception',
    confidence: 'sure',
    picks: [1]
};

test('lịch ôn là 1 -> 3 -> 7 ngày', () => {
    assert.deepEqual(REVIEW_INTERVALS_DAYS, [1, 3, 7]);
    assert.equal(MASTERED_STAGE, 3);
});

test('wrongPicks: một đáp án, nhiều đáp án, và dạng không có đáp án để chọn', () => {
    assert.deepEqual(wrongPicks('single', 1, 2), [1]);
    assert.deepEqual(wrongPicks('single', 2, 2), []);
    assert.deepEqual(wrongPicks('single', null, 2), []);
    assert.deepEqual(wrongPicks('multi', [0, 1, 3], [0, 3]), [1]);
    assert.deepEqual(wrongPicks('multi', [0], [0, 3]), []);
    assert.deepEqual(wrongPicks('truefalse', false, true), []);
    assert.deepEqual(wrongPicks('fill', 'abc', 'x'), []);
});

test('applyWrong: câu sai lần đầu hẹn ôn sau 1 ngày, đếm đáp án nhiễu', () => {
    const d = applyWrong(null, incoming, NOW);
    assert.equal(d.status, 'open');
    assert.equal(d.stage, 0);
    assert.equal(d.wrongCount, 1);
    assert.equal(d.nextReviewAt.getTime(), NOW + DAY);
    assert.deepEqual(d.wrongOptionCounts, { 1: 1 });
    assert.equal(d.correct, 2);
    assert.equal(d.errorType, 'misconception');
});

test('applyWrong: sai lại thì cộng dồn, về mốc đầu, mở lại câu đã nắm; correct=false được giữ', () => {
    const prev = { wrongCount: 2, reviewCount: 3, stage: 2, status: 'mastered', wrongOptionCounts: { 1: 1, 3: 1 }, errorType: 'knowledge' };
    const d = applyWrong(prev, { ...incoming, errorType: null, picks: [1] }, NOW);
    assert.equal(d.wrongCount, 3);
    assert.equal(d.reviewCount, 3);
    assert.equal(d.stage, 0);
    assert.equal(d.status, 'open');
    assert.deepEqual(d.wrongOptionCounts, { 1: 2, 3: 1 });
    assert.equal(d.errorType, 'knowledge');
    assert.equal(applyWrong(null, { ...incoming, type: 'truefalse', correct: false, picks: [] }, NOW).correct, false);
});

test('nextStage: sai về 0, đoán trúng giữ nguyên, phân vân không được nắm ngay, chắc chắn thì lên mốc', () => {
    assert.deepEqual(nextStage({ stage: 2, status: 'wrong' }), { stage: 0, mastered: false });
    assert.deepEqual(nextStage({ stage: 1, status: 'correct', confidence: 'guess' }), { stage: 1, mastered: false });
    assert.deepEqual(nextStage({ stage: 0, status: 'correct', confidence: 'sure' }), { stage: 1, mastered: false });
    assert.deepEqual(nextStage({ stage: 0, status: 'correct' }), { stage: 1, mastered: false });
    assert.deepEqual(nextStage({ stage: 2, status: 'correct', confidence: 'unsure' }), { stage: 2, mastered: false });
    assert.deepEqual(nextStage({ stage: 2, status: 'correct', confidence: 'sure' }), { stage: 3, mastered: true });
    assert.deepEqual(nextStage({ stage: 2, status: 'correct' }), { stage: 3, mastered: true });
    assert.deepEqual(nextStage({ stage: 99, status: 'correct' }), { stage: 3, mastered: true });
    assert.deepEqual(nextStage({ stage: undefined, status: 'correct' }), { stage: 1, mastered: false });
});

test('applyReview: đi hết 1 -> 3 -> 7 thì đã nắm và không còn lịch ôn', () => {
    let doc = applyWrong(null, incoming, NOW);
    const days = [];
    let t = NOW;
    for (let i = 0; i < 3; i++) {
        const patch = applyReview(doc, { status: 'correct' }, t);
        days.push(patch.nextReviewAt ? (patch.nextReviewAt.getTime() - t) / DAY : null);
        doc = { ...doc, ...patch };
        t += DAY;
    }
    assert.deepEqual(days, [3, 7, null]);
    assert.equal(doc.status, 'mastered');
    assert.equal(doc.nextReviewAt, null);
    assert.equal(doc.reviewCount, 3);
});

test('applyReview: sai khi ôn thì về mốc đầu, đếm lỗi và đáp án nhiễu', () => {
    const doc = { ...applyWrong(null, incoming, NOW), stage: 2 };
    const p = applyReview(doc, { status: 'wrong', picks: [3] }, NOW);
    assert.equal(p.stage, 0);
    assert.equal(p.status, 'open');
    assert.equal(p.wrongCount, 2);
    assert.deepEqual(p.wrongOptionCounts, { 1: 1, 3: 1 });
    assert.equal(p.nextReviewAt.getTime(), NOW + DAY);
    assert.equal(p.lastResult, 'wrong');
});

test('applyReview: đúng thì không đổi đáp án nhiễu cũ', () => {
    const doc = applyWrong(null, incoming, NOW);
    assert.deepEqual(applyReview(doc, { status: 'correct', picks: [3] }, NOW).wrongOptionCounts, { 1: 1 });
});

test('topWrongOption: đáp án sai bị chọn nhiều nhất', () => {
    assert.equal(topWrongOption({}), null);
    assert.equal(topWrongOption({ wrongOptionCounts: { x: 3 } }), null);
    assert.deepEqual(topWrongOption({ options: ['A', 'B', 'C'], wrongOptionCounts: { 0: 1, 2: 4 } }), { index: 2, count: 4, text: 'C' });
});

test('câu hỏi gửi đi ôn không lộ đáp án, giải thích hay kiểu sai', () => {
    const doc = applyWrong(null, incoming, NOW);
    const q = toReviewQuestion(doc);
    assert.deepEqual(Object.keys(q).sort(), ['id', 'options', 'stage', 'stem', 'topicId', 'type']);
    const text = JSON.stringify(q);
    assert.equal(text.includes('vì C'), false);
    assert.equal(text.includes('correct'), false);
    assert.deepEqual(q.options[2], { index: 2, text: 'C' });
});

test('dòng trong sổ lỗi sai: đổi Date/Timestamp sang ISO, có đáp án và tên chủ đề', () => {
    const doc = { ...applyWrong(null, incoming, NOW), lastReviewedAt: { toMillis: () => NOW } };
    const item = toListItem(doc, { t1: { name: 'Hàm số' } });
    assert.equal(item.topicName, 'Hàm số');
    assert.equal(item.nextReviewAt, new Date(NOW + DAY).toISOString());
    assert.equal(item.lastReviewedAt, new Date(NOW).toISOString());
    assert.equal(item.correct, 2);
    assert.deepEqual(item.topWrong, { index: 1, count: 1, text: 'B' });
    const mastered = toListItem({ ...doc, status: 'mastered', nextReviewAt: null });
    assert.equal(mastered.nextReviewAt, null);
});

test('summarizeMistakes: đếm theo kiểu sai và chủ đề nhiều câu sai nhất lên đầu', () => {
    const out = summarizeMistakes([
        { topicId: 't1', errorType: 'guess', wrongCount: 1 },
        { topicId: 't2', errorType: 'guess', wrongCount: 2 },
        { topicId: 't2', errorType: 'knowledge', wrongCount: 1 },
        { topicId: null, errorType: null, wrongCount: 1 }
    ]);
    assert.equal(out.total, 4);
    assert.deepEqual(out.byErrorType, { guess: 2, knowledge: 1 });
    assert.equal(out.weakTopics[0].topicId, 't2');
    assert.equal(out.weakTopics[0].mistakes, 2);
    assert.equal(out.weakTopics.at(-1).topicId, null);
});

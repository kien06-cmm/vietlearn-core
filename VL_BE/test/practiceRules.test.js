// Chức năng: kiểm thử luật chọn câu "Luyện phần yếu" (không gọi mạng/DB). Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { MISTAKE_SHARE, pickPractice, toPracticeQuestion } from '../quiz/practiceRules.js';

const noShuffle = () => 0.999999; // Fisher-Yates với số này giữ nguyên thứ tự
const m = (id, status = 'open', wrongCount = 1) => ({ questionId: id, status, wrongCount });
const b = (id) => ({ id, type: 'single', stem: `Câu ${id}`, options: ['A', 'B'], topicId: 't1', explanation: 'bí mật' });
const ids = (picked) => picked.map((p) => (p.kind === 'mistake' ? p.doc.questionId : p.q.id));

test('chọn tối đa 60% câu sai, còn lại là câu mới từ ngân hàng', () => {
    const mistakes = [m('m1'), m('m2'), m('m3'), m('m4'), m('m5'), m('m6'), m('m7'), m('m8')];
    const bank = [b('b1'), b('b2'), b('b3'), b('b4'), b('b5'), b('b6')];
    const picked = pickPractice(mistakes, bank, 10, noShuffle);
    assert.equal(picked.length, 10);
    assert.equal(picked.filter((p) => p.kind === 'mistake').length, Math.ceil(10 * MISTAKE_SHARE));
    assert.equal(picked.filter((p) => p.kind === 'bank').length, 4);
});

test('câu sai: đang ôn trước, sai nhiều trước', () => {
    const mistakes = [m('done', 'mastered', 9), m('few', 'open', 1), m('many', 'open', 5)];
    const picked = pickPractice(mistakes, [], 2, noShuffle);
    assert.deepEqual(ids(picked).sort(), ['few', 'many']);
});

test('câu ngân hàng đã có trong sổ lỗi sai không bị lấy lần hai', () => {
    const picked = pickPractice([m('x')], [b('x'), b('y')], 5, noShuffle);
    assert.deepEqual(ids(picked).sort(), ['x', 'y']);
    assert.equal(picked.filter((p) => p.kind === 'mistake').length, 1);
});

test('thiếu câu mới thì bù bằng câu sai còn lại; thiếu cả hai thì trả ít hơn limit', () => {
    const mistakes = [m('m1'), m('m2'), m('m3'), m('m4'), m('m5')];
    assert.equal(pickPractice(mistakes, [b('b1')], 5, noShuffle).length, 5);
    assert.equal(pickPractice([m('m1')], [b('b1')], 10, noShuffle).length, 2);
    assert.deepEqual(pickPractice([], [], 10, noShuffle), []);
    assert.deepEqual(pickPractice(null, null, 10, noShuffle), []);
});

test('không có câu sai thì toàn bộ là câu ngân hàng; không vượt limit', () => {
    const bank = Array.from({ length: 30 }, (_, i) => b(`b${i}`));
    const picked = pickPractice([], bank, 10, noShuffle);
    assert.equal(picked.length, 10);
    assert.ok(picked.every((p) => p.kind === 'bank'));
});

test('câu gửi đi luyện không lộ đáp án, giải thích hay nguồn', () => {
    const q = toPracticeQuestion(b('b1'));
    assert.deepEqual(Object.keys(q).sort(), ['fresh', 'id', 'options', 'stage', 'stem', 'topicId', 'type', 'unreviewed']);
    assert.equal(JSON.stringify(q).includes('bí mật'), false);
    assert.deepEqual(q.options[1], { index: 1, text: 'B' });
    assert.equal(q.fresh, true);
});

test('câu AI tạo để luyện (chưa duyệt) được đánh dấu unreviewed, câu đã duyệt thì không', () => {
    assert.equal(toPracticeQuestion({ ...b('b1'), reviewStatus: 'draft', origin: 'ai-practice' }).unreviewed, true);
    assert.equal(toPracticeQuestion({ ...b('b1'), reviewStatus: 'approved' }).unreviewed, false);
});

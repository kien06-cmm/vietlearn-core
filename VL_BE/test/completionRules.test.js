// Chức năng: kiểm thử luật "chủ đề đã ôn xong" - gom câu theo chủ đề, tổng quan, chọn câu ôn lại (khó / tất cả), hẹn xóa khi hoàn thành, hủy hẹn khi ôn lại. Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    ARCHIVE_TTL_DAYS,
    HARD_WRONG_COUNT,
    MAX_HARDEST,
    MASTERED_TTL_DAYS,
    NO_TOPIC,
    archivePatch,
    expireIn,
    groupByTopic,
    isHard,
    isPurgeable,
    restartPatch,
    restartTargets,
    summarizeFinished,
    topicKey
} from '../quiz/completionRules.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 10, 8, 0, 0);

const doc = (id, wrongCount, extra = {}) => ({ questionId: id, stem: `Câu ${id}`, topicId: 't1', wrongCount, reviewCount: 3, ...extra });

test('câu khó là câu sai từ ngưỡng trở lên', () => {
    assert.equal(HARD_WRONG_COUNT, 2);
    assert.equal(isHard(doc('a', 1)), false);
    assert.equal(isHard(doc('a', 2)), true);
    assert.equal(isHard(doc('a', 5)), true);
    assert.equal(isHard({}), false);
    assert.equal(isHard(null), false);
});

test('gom theo chủ đề; câu không có chủ đề vào nhóm riêng', () => {
    const groups = groupByTopic([doc('a', 1), doc('b', 1, { topicId: 't2' }), doc('c', 1, { topicId: null }), doc('d', 1), doc('e', 1, { topicId: undefined })]);
    assert.deepEqual([...groups.keys()], ['t1', 't2', NO_TOPIC]);
    assert.equal(groups.get('t1').length, 2);
    assert.equal(groups.get(NO_TOPIC).length, 2);
    assert.equal(topicKey(null), NO_TOPIC);
    assert.equal(topicKey('t9'), 't9');
    assert.equal(groupByTopic(undefined).size, 0);
});

test('tổng quan: số câu, câu khó, tổng lần sai và lần ôn, câu khó nhất', () => {
    const s = summarizeFinished([doc('a', 1), doc('b', 4), doc('c', 2), doc('d', 3), doc('e', 2)]);
    assert.equal(s.questions, 5);
    assert.equal(s.hard, 4);
    assert.equal(s.wrongTotal, 12);
    assert.equal(s.reviewTotal, 15);
    assert.equal(s.hardest.length, MAX_HARDEST);
    assert.deepEqual(s.hardest.map((h) => h.id), ['b', 'd', 'c']); // sai nhiều nhất trước
    assert.deepEqual(s.hardest[0], { id: 'b', stem: 'Câu b', wrongCount: 4 });
});

test('tổng quan chủ đề không có câu khó: hardest rỗng', () => {
    const s = summarizeFinished([doc('a', 1), doc('b', 1)]);
    assert.equal(s.hard, 0);
    assert.deepEqual(s.hardest, []);
    assert.deepEqual(summarizeFinished([]), { questions: 0, hard: 0, wrongTotal: 0, reviewTotal: 0, hardest: [] });
});

test('ôn lại: mặc định chỉ câu khó, scope all thì tất cả', () => {
    const docs = [doc('a', 1), doc('b', 2), doc('c', 3)];
    assert.deepEqual(restartTargets(docs, 'hard').map((d) => d.questionId), ['b', 'c']);
    assert.deepEqual(restartTargets(docs, undefined).map((d) => d.questionId), ['b', 'c']);
    assert.deepEqual(restartTargets(docs, 'all').map((d) => d.questionId), ['a', 'b', 'c']);
    assert.deepEqual(restartTargets([doc('a', 1)], 'hard'), []);
    assert.deepEqual(restartTargets(undefined, 'all'), []);
});

test('hoàn thành: lưu trữ và hẹn xóa sau 90 ngày', () => {
    const p = archivePatch(NOW);
    assert.equal(p.status, 'archived');
    assert.equal(p.expireAt.getTime(), NOW + ARCHIVE_TTL_DAYS * DAY);
    assert.equal(p.archivedAt.getTime(), NOW);
    assert.equal(ARCHIVE_TTL_DAYS, 90);
});

test('ôn lại: mở lại ở mốc đầu, đến hạn ngay, hủy hẹn xóa', () => {
    const p = restartPatch(NOW);
    assert.equal(p.status, 'open');
    assert.equal(p.stage, 0);
    assert.equal(p.nextReviewAt.getTime(), NOW);
    assert.equal(p.expireAt, null);
});

test('câu đã nắm mà không ai bấm gì cũng hết hạn, lâu hơn câu đã hoàn thành', () => {
    assert.equal(expireIn(MASTERED_TTL_DAYS, NOW).getTime(), NOW + 180 * DAY);
    assert.ok(MASTERED_TTL_DAYS > ARCHIVE_TTL_DAYS);
});

test('dọn hết hạn: chỉ xóa câu có expireAt đã qua (Date hoặc Timestamp của Firestore)', () => {
    const past = new Date(NOW - DAY);
    const future = new Date(NOW + DAY);
    assert.equal(isPurgeable({ status: 'archived', expireAt: past }, NOW), true);
    assert.equal(isPurgeable({ status: 'mastered', expireAt: { toMillis: () => NOW - 1 } }, NOW), true);
    assert.equal(isPurgeable({ status: 'archived', expireAt: future }, NOW), false);
    assert.equal(isPurgeable({ status: 'archived', expireAt: null }, NOW), false);
    assert.equal(isPurgeable({ status: 'archived' }, NOW), false);
    assert.equal(isPurgeable(null, NOW), false);
});

test('dọn hết hạn: câu đang ôn không bao giờ bị xóa dù còn sót expireAt đã qua', () => {
    assert.equal(isPurgeable({ status: 'open', expireAt: new Date(NOW - DAY) }, NOW), false);
});

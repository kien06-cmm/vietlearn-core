// Chức năng: kiểm thử luật mức thành thạo theo chủ đề (không gọi mạng/DB): gom kết quả, chuỗi gần nhất, xếp loại, bản đồ kiến thức. Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    MIN_SAMPLE,
    RECENT_MAX,
    applyOutcomes,
    buildKnowledgeMap,
    countLevels,
    levelOf,
    outcomeOf,
    outcomesByTopic,
    scoreOf,
    toMasteryItem
} from '../quiz/masteryRules.js';

const NOW = Date.UTC(2026, 9, 9, 8, 0, 0);

test('outcomeOf: đúng, đoán trúng, sai; còn lại không phải bằng chứng', () => {
    assert.equal(outcomeOf('correct', 'sure'), 'c');
    assert.equal(outcomeOf('correct', null), 'c');
    assert.equal(outcomeOf('correct', 'unsure'), 'c');
    assert.equal(outcomeOf('correct', 'guess'), 'g');
    assert.equal(outcomeOf('wrong', 'guess'), 'w');
    assert.equal(outcomeOf('unanswered'), null);
    assert.equal(outcomeOf('pending'), null);
});

test('outcomesByTopic: gom theo chủ đề, bỏ câu ngắn, câu không chủ đề và câu bỏ trống', () => {
    const questions = [
        { id: 'a', type: 'single', topicId: 't1' },
        { id: 'b', type: 'single', topicId: 't1' },
        { id: 'c', type: 'fill', topicId: 't2' },
        { id: 'd', type: 'short', topicId: 't2' },
        { id: 'e', type: 'single', topicId: null },
        { id: 'f', type: 'single', topicId: 't1' }
    ];
    const statuses = { a: 'correct', b: 'wrong', c: 'correct', d: 'pending', e: 'wrong', f: 'unanswered' };
    const out = outcomesByTopic(questions, statuses, { a: 'guess' });
    assert.deepEqual([...out], [['t1', 'gw'], ['t2', 'c']]);
    assert.equal(outcomesByTopic(null, null, null).size, 0);
});

test('applyOutcomes: cộng dồn, chỉ giữ RECENT_MAX câu gần nhất, đếm tổng', () => {
    const first = applyOutcomes(null, 'cw', NOW);
    assert.equal(first.recent, 'cw');
    assert.equal(first.total, 2);
    assert.equal(first.lastAt.getTime(), NOW);

    const long = applyOutcomes({ recent: 'w'.repeat(RECENT_MAX), total: 50 }, 'ccc', NOW);
    assert.equal(long.recent.length, RECENT_MAX);
    assert.equal(long.recent.endsWith('ccc'), true);
    assert.equal(long.recent.startsWith('w'), true);
    assert.equal(long.total, 53);

    assert.equal(applyOutcomes({ recent: 'c?x' }, 'w', NOW).recent, 'cw'); // ký tự lạ bị bỏ
});

test('scoreOf: đoán trúng tính nửa điểm', () => {
    assert.equal(scoreOf(''), null);
    assert.equal(scoreOf(undefined), null);
    assert.equal(scoreOf('ccww'), 0.5);
    assert.equal(scoreOf('gg'), 0.5);
    assert.equal(scoreOf('cccc'), 1);
});

test('levelOf: chưa đủ dữ liệu thì chưa xếp loại; ngưỡng 50% và 80%', () => {
    assert.equal(levelOf(MIN_SAMPLE - 1, 0), 'new');
    assert.equal(levelOf(0, null), 'new');
    assert.equal(levelOf(5, 0.49), 'weak');
    assert.equal(levelOf(5, 0.5), 'learning');
    assert.equal(levelOf(5, 0.79), 'learning');
    assert.equal(levelOf(5, 0.8), 'strong');
});

test('toMasteryItem: phần trăm, mức, tên chủ đề (chủ đề đã xóa thì không có tên)', () => {
    const item = toMasteryItem({ topicId: 't1', recent: 'ccccw', total: 12, lastAt: { toMillis: () => NOW } }, { name: 'Hàm số', chapter: 'Chương 1', subject: 'Toán' });
    assert.equal(item.percent, 80);
    assert.equal(item.level, 'strong');
    assert.equal(item.sample, 5);
    assert.equal(item.answered, 12);
    assert.equal(item.name, 'Hàm số');
    assert.equal(item.lastAt, new Date(NOW).toISOString());

    const orphan = toMasteryItem({ topicId: 't9', recent: 'ww' }, undefined);
    assert.equal(orphan.name, null);
    assert.equal(orphan.level, 'new');
    assert.equal(orphan.percent, 0);
    assert.equal(orphan.lastAt, null);
});

test('buildKnowledgeMap: Môn -> Chương -> Chủ đề, tổng hợp theo trọng số, danh sách chủ đề yếu', () => {
    const mk = (topicId, subject, chapter, name, recent) => toMasteryItem({ topicId, recent }, { subject, chapter, name });
    const items = [
        mk('t1', 'Toán', 'Chương 2', 'Đạo hàm', 'wwwwc'), // 20% yếu
        mk('t2', 'Toán', 'Chương 1', 'Hàm số', 'cccccc'), // 100% vững
        mk('t3', 'Toán', 'Chương 1', 'Giới hạn', 'cwcw'), // 4 câu: chưa đủ dữ liệu
        mk('t4', 'Hóa', 'Chương 1', 'Axit', 'wwwwww'), // 0% yếu nhất
        { topicId: 't5', name: null, chapter: null, subject: null, sample: 5, answered: 5, percent: 60, level: 'learning', lastAt: null }
    ];
    const { map, weakest, counts } = buildKnowledgeMap(items);

    assert.deepEqual(map.map((s) => s.subject), ['Chưa phân loại', 'Hóa', 'Toán']);
    const toan = map.find((s) => s.subject === 'Toán');
    assert.deepEqual(toan.chapters.map((c) => c.chapter), ['Chương 1', 'Chương 2']);
    assert.deepEqual(toan.chapters[0].topics.map((t) => t.name), ['Giới hạn', 'Hàm số']);
    // Chương 1: 6 câu đạt 100% + 4 câu đạt 50% -> (6 + 2) / 10 = 80%
    assert.equal(toan.chapters[0].percent, 80);
    assert.equal(toan.chapters[0].level, 'strong');
    assert.equal(map[0].chapters[0].chapter, 'Chưa rõ chương');

    assert.deepEqual(weakest.map((t) => t.topicId), ['t4', 't1']); // yếu nhất lên đầu, chủ đề chưa đủ dữ liệu không bị gọi là yếu
    assert.deepEqual(counts, { new: 1, weak: 2, learning: 1, strong: 1 });
    assert.equal(buildKnowledgeMap(items, 1).weakest.length, 1);
});

test('buildKnowledgeMap: chưa có dữ liệu thì rỗng', () => {
    assert.deepEqual(buildKnowledgeMap([]), { map: [], weakest: [], counts: { new: 0, weak: 0, learning: 0, strong: 0 } });
    assert.deepEqual(countLevels([]), { new: 0, weak: 0, learning: 0, strong: 0 });
});

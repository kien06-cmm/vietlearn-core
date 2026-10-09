// Chức năng: kiểm thử luật Heatmap của chủ phòng (không gọi mạng/DB): cộng dồn, ngưỡng 5 bài, mức nhiệt, "3 điều cần ôn lại". Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { MIN_SUBMISSIONS, buildHeatmap, levelOf, statIncrements } from '../quiz/heatmapRules.js';

const questions = [
    { id: 'q1', type: 'single', stem: 'Câu 1', topicId: 't1' },
    { id: 'q2', type: 'single', stem: 'Câu 2', topicId: 't1' },
    { id: 'q3', type: 'truefalse', stem: 'Câu 3', topicId: 't2' },
    { id: 'q4', type: 'short', stem: 'Câu trả lời ngắn', topicId: 't2' },
    { id: 'q5', type: 'fill', stem: 'Câu 5', topicId: null },
    { id: 'q6', type: 'multi', stem: 'Câu 6', topicId: 't3' }
];
const topicInfo = { t1: { name: 'Phân số', subject: 'Toán', chapter: 'Chương 1' }, t2: { name: 'Hàm số' }, t3: { name: 'Hình học' } };

test('mức nhiệt theo tỉ lệ sai, chưa đủ dữ liệu thì không tô màu', () => {
    assert.equal(levelOf(0.7, true), 'hot');
    assert.equal(levelOf(0.4, true), 'warm');
    assert.equal(levelOf(0.2, true), 'mild');
    assert.equal(levelOf(0.1, true), 'cool');
    assert.equal(levelOf(0.9, false), 'none');
    assert.equal(levelOf(null, true), 'none');
});

test('cộng dồn một bài: đúng, sai, bỏ trống; bỏ câu trả lời ngắn và câu chưa chấm', () => {
    const inc = statIncrements(questions, { q1: 'correct', q2: 'wrong', q3: 'unanswered', q4: 'pending', q5: 'wrong' });
    assert.deepEqual(inc.q1, { answered: 1, wrong: 0, skipped: 0 });
    assert.deepEqual(inc.q2, { answered: 1, wrong: 1, skipped: 0 });
    assert.deepEqual(inc.q3, { answered: 0, wrong: 0, skipped: 1 });
    assert.equal(inc.q4, undefined);
    assert.equal(inc.q6, undefined); // không có trạng thái thì không cộng
});

test('dưới ngưỡng bài nộp thì không trả thống kê nào', () => {
    const stats = { q1: { answered: 4, wrong: 4, skipped: 0 } };
    const h = buildHeatmap({ questions, stats, submitted: MIN_SUBMISSIONS - 1, topicInfo });
    assert.equal(h.ready, false);
    assert.equal(h.submitted, MIN_SUBMISSIONS - 1);
    assert.equal(h.needed, MIN_SUBMISSIONS);
    assert.deepEqual(h.questions, []);
    assert.deepEqual(h.reviewPoints, []);
    assert.equal(buildHeatmap({ questions, stats, submitted: undefined, topicInfo }).ready, false);
});

test('đủ ngưỡng: câu có tỉ lệ sai, bỏ câu trả lời ngắn, đánh số lại theo câu tự chấm', () => {
    const stats = {
        q1: { answered: 10, wrong: 8, skipped: 0 },
        q2: { answered: 10, wrong: 1, skipped: 2 },
        q3: { answered: 3, wrong: 3, skipped: 7 }, // chưa đủ 5 lượt trả lời
        q5: { answered: 10, wrong: 5, skipped: 0 },
        q6: { answered: 10, wrong: 0, skipped: 0 }
    };
    const h = buildHeatmap({ questions, stats, submitted: 10, topicInfo });
    assert.equal(h.ready, true);
    assert.deepEqual(h.questions.map((q) => q.id), ['q1', 'q2', 'q3', 'q5', 'q6']);
    assert.deepEqual(h.questions.map((q) => q.no), [1, 2, 3, 4, 5]);
    const byId = Object.fromEntries(h.questions.map((q) => [q.id, q]));
    assert.equal(byId.q1.level, 'hot');
    assert.equal(byId.q2.level, 'cool');
    assert.equal(byId.q2.skipped, 2);
    assert.equal(byId.q3.level, 'none'); // chưa đủ dữ liệu: không kết luận
    assert.equal(byId.q5.level, 'warm');
});

test('3 điều cần ôn lại: chủ đề yếu nhất trước, rồi bù bằng câu khó của chủ đề chưa chọn', () => {
    const stats = {
        q1: { answered: 10, wrong: 9, skipped: 0 }, // t1: 10/20 sai
        q2: { answered: 10, wrong: 1, skipped: 0 },
        q3: { answered: 10, wrong: 6, skipped: 0 }, // t2: 6/10 sai
        q5: { answered: 10, wrong: 5, skipped: 0 }, // không có chủ đề
        q6: { answered: 10, wrong: 1, skipped: 0 } // t3: 1/10 sai
    };
    const h = buildHeatmap({ questions, stats, submitted: 10, topicInfo });
    assert.equal(h.reviewPoints.length, 3);
    assert.deepEqual(h.reviewPoints.map((p) => [p.kind, p.title]), [
        ['topic', 'Hàm số'],
        ['topic', 'Phân số'],
        ['question', 'Câu 5']
    ]);
    assert.ok(h.reviewPoints[0].wrongRate > h.reviewPoints[1].wrongRate);
});

test('lớp làm tốt (không phần nào sai từ 30%) thì không có điều cần ôn', () => {
    const stats = Object.fromEntries(['q1', 'q2', 'q3', 'q5', 'q6'].map((id) => [id, { answered: 10, wrong: 1, skipped: 0 }]));
    const h = buildHeatmap({ questions, stats, submitted: 10, topicInfo });
    assert.equal(h.ready, true);
    assert.deepEqual(h.reviewPoints, []);
});

test('câu có chủ đề đã chọn thì không lặp lại trong danh sách; chủ đề thiếu dữ liệu không được chọn', () => {
    const stats = {
        q1: { answered: 10, wrong: 8, skipped: 0 },
        q2: { answered: 10, wrong: 8, skipped: 0 },
        q3: { answered: 4, wrong: 4, skipped: 0 }, // t2 mới 4 lượt: chưa đủ
        q6: { answered: 10, wrong: 7, skipped: 0 }
    };
    const h = buildHeatmap({ questions, stats, submitted: 10, topicInfo });
    assert.deepEqual(h.reviewPoints.map((p) => p.title), ['Phân số', 'Hình học']);
    assert.ok(h.reviewPoints.every((p) => p.kind === 'topic'));
});

test('câu hỏi dài được cắt gọn khi hiện trên bản đồ', () => {
    const long = [{ id: 'a', type: 'single', stem: 'x'.repeat(500), topicId: null }];
    const h = buildHeatmap({ questions: long, stats: { a: { answered: 10, wrong: 9, skipped: 0 } }, submitted: 10 });
    assert.ok(h.questions[0].stem.length <= 120);
    assert.ok(h.questions[0].stem.endsWith('…'));
});

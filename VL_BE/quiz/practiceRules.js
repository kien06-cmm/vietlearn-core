// Chức năng: luật thuần cho "Luyện phần yếu" (Phase 5) - chọn bộ câu luyện cho một chủ đề từ câu từng sai và câu đã duyệt trong ngân hàng. Không gọi mạng/DB nên dễ test.
// Không gọi AI nên không tốn credits. Câu mới do AI soạn từ câu từng sai (Weakness -> Practice) được tạo ở job riêng (ai/weaknessRules.js, worker/generatePractice.js),
// lưu vào questions với origin 'ai-practice' và nằm trong ngân hàng ở đây như câu bình thường (có cờ unreviewed).

export const MISTAKE_SHARE = 0.6; // tối đa 60% bộ câu là câu từng sai, phần còn lại là câu mới từ ngân hàng để không chỉ lặp lại câu cũ

function shuffle(list, rand) {
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// mistakes: bản ghi sổ lỗi sai của chủ đề; bank: câu đã duyệt trong ngân hàng ({ id, ... }); rand: để test cố định kết quả.
// Câu sai: đang ôn trước, sai nhiều trước. Câu ngân hàng đã có trong sổ thì không lấy lần nữa. Thiếu câu mới thì bù bằng câu sai còn lại.
// Trả mảng [{ kind: 'mistake', doc } | { kind: 'bank', q }] đã xáo trộn, tối đa `limit` câu.
export function pickPractice(mistakes, bank, limit, rand = Math.random) {
    const ranked = [...(mistakes || [])].sort(
        (a, b) => (a.status === 'open' ? 0 : 1) - (b.status === 'open' ? 0 : 1) || (b.wrongCount || 0) - (a.wrongCount || 0)
    );
    const known = new Set(ranked.map((d) => d.questionId));
    const fresh = shuffle((bank || []).filter((q) => !known.has(q.id)), rand);

    const takeMistakes = Math.min(ranked.length, Math.ceil(limit * MISTAKE_SHARE));
    const picked = [
        ...ranked.slice(0, takeMistakes).map((doc) => ({ kind: 'mistake', doc })),
        ...fresh.slice(0, limit - takeMistakes).map((q) => ({ kind: 'bank', q }))
    ];
    if (picked.length < limit) {
        const more = ranked.slice(takeMistakes, takeMistakes + (limit - picked.length));
        picked.push(...more.map((doc) => ({ kind: 'mistake', doc })));
    }
    return shuffle(picked, rand);
}

// Câu từ ngân hàng gửi đi luyện: KHÔNG có đáp án, giải thích hay nguồn. Cùng dạng với toReviewQuestion; fresh = chưa có trong sổ lỗi sai.
export function toPracticeQuestion(q) {
    return {
        id: q.id,
        type: q.type,
        stem: q.stem,
        options: (q.options || []).map((text, index) => ({ index, text })),
        topicId: q.topicId ?? null,
        stage: null,
        fresh: true,
        unreviewed: q.reviewStatus !== 'approved' // câu AI tạo riêng để luyện phần yếu, chủ sở hữu chưa duyệt: giao diện hiện nhãn
    };
}

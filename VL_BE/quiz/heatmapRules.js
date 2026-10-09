// Chức năng: luật thuần cho Heatmap của chủ phòng (Phase 5) - cộng dồn đúng/sai từng câu khi có người nộp bài, rồi dựng bản đồ nhiệt + "3 điều cần ôn lại". Không gọi mạng/DB nên dễ test.
// Quyền riêng tư: chỉ có thống kê gộp, không có tên người nào. Dưới ngưỡng MIN_SUBMISSIONS bài nộp thì không trả thống kê nào (ít người quá thì suy ra được ai sai câu nào).

export const MIN_SUBMISSIONS = 5; // cần ít nhất 5 bài nộp mới hiện thống kê
export const TOP_REVIEW_POINTS = 3; // "3 điều cần ôn lại"
export const WEAK_WRONG_RATE = 0.3; // tỉ lệ sai từ 30% trở lên mới đáng đưa vào danh sách cần ôn
export const STEM_PREVIEW_CHARS = 120;

// Mức nhiệt theo tỉ lệ sai. 'none' = chưa đủ dữ liệu cho câu đó.
export function levelOf(wrongRate, enough) {
    if (!enough || wrongRate == null) return 'none';
    if (wrongRate >= 0.6) return 'hot';
    if (wrongRate >= 0.4) return 'warm';
    if (wrongRate >= 0.2) return 'mild';
    return 'cool';
}

// Số cần cộng cho MỘT bài vừa nộp: { [questionId]: { answered, wrong, skipped } }.
// Chỉ tính câu tự chấm được (bỏ câu trả lời ngắn). answered = đã trả lời (đúng hoặc sai); skipped = bỏ trống.
export function statIncrements(questions, statuses) {
    const out = {};
    for (const q of questions || []) {
        if (q.type === 'short') continue;
        const status = statuses?.[q.id];
        if (status === 'correct') out[q.id] = { answered: 1, wrong: 0, skipped: 0 };
        else if (status === 'wrong') out[q.id] = { answered: 1, wrong: 1, skipped: 0 };
        else if (status === 'unanswered') out[q.id] = { answered: 0, wrong: 0, skipped: 1 };
    }
    return out;
}

const preview = (text) => {
    const s = String(text ?? '').replace(/\s+/g, ' ').trim();
    return s.length > STEM_PREVIEW_CHARS ? `${s.slice(0, STEM_PREVIEW_CHARS - 1)}…` : s;
};

const byRateThenSize = (a, b) => b.wrongRate - a.wrongRate || b.answered - a.answered;

// questions: các câu của version (có id, type, stem, topicId); stats: { [questionId]: { answered, wrong, skipped } };
// submitted: số bài đã nộp trong phòng; topicInfo: { [topicId]: { name, chapter, subject } }.
export function buildHeatmap({ questions, stats, submitted, topicInfo = {}, min = MIN_SUBMISSIONS }) {
    const base = { submitted: submitted || 0, needed: min };
    if (!Number.isInteger(submitted) || submitted < min) {
        return { ...base, ready: false, questions: [], topics: [], reviewPoints: [] };
    }

    const rows = [];
    const topicMap = new Map();
    let no = 0;
    for (const q of questions || []) {
        if (q.type === 'short') continue;
        no++;
        const s = stats?.[q.id] || {};
        const answered = s.answered || 0;
        const wrong = s.wrong || 0;
        const skipped = s.skipped || 0;
        const enough = answered >= min;
        const wrongRate = answered ? wrong / answered : null;
        rows.push({
            id: q.id,
            no,
            stem: preview(q.stem),
            topicId: q.topicId ?? null,
            answered,
            wrong,
            skipped,
            wrongRate,
            level: levelOf(wrongRate, enough),
            enough
        });
        if (q.topicId) {
            const t = topicMap.get(q.topicId) || { topicId: q.topicId, answered: 0, wrong: 0, questions: 0 };
            t.answered += answered;
            t.wrong += wrong;
            t.questions++;
            topicMap.set(q.topicId, t);
        }
    }

    const topics = [...topicMap.values()]
        .map((t) => {
            const info = topicInfo[t.topicId] || {};
            const enough = t.answered >= min;
            const wrongRate = t.answered ? t.wrong / t.answered : null;
            return {
                ...t,
                name: info.name ?? null,
                chapter: info.chapter ?? null,
                subject: info.subject ?? null,
                wrongRate,
                level: levelOf(wrongRate, enough),
                enough
            };
        })
        .sort((a, b) => (b.wrongRate ?? -1) - (a.wrongRate ?? -1) || b.answered - a.answered);

    // "3 điều cần ôn lại": ưu tiên chủ đề (có tên), rồi bù bằng câu khó nhất của chủ đề chưa được chọn (hoặc câu không có chủ đề)
    const points = [];
    const usedTopics = new Set();
    for (const t of topics.filter((x) => x.enough && x.name && x.wrongRate >= WEAK_WRONG_RATE).sort(byRateThenSize)) {
        if (points.length >= TOP_REVIEW_POINTS) break;
        usedTopics.add(t.topicId);
        points.push({ kind: 'topic', topicId: t.topicId, title: t.name, detail: [t.subject, t.chapter].filter(Boolean).join(' · '), wrongRate: t.wrongRate, wrong: t.wrong, answered: t.answered });
    }
    if (points.length < TOP_REVIEW_POINTS) {
        const hardest = rows.filter((r) => r.enough && r.wrongRate >= WEAK_WRONG_RATE && !(r.topicId && usedTopics.has(r.topicId))).sort(byRateThenSize);
        for (const r of hardest) {
            if (points.length >= TOP_REVIEW_POINTS) break;
            points.push({ kind: 'question', questionId: r.id, no: r.no, title: r.stem, detail: `Câu ${r.no}`, wrongRate: r.wrongRate, wrong: r.wrong, answered: r.answered });
        }
    }

    return { ...base, ready: true, questions: rows, topics, reviewPoints: points };
}

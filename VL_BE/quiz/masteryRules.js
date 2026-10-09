// Chức năng: luật thuần cho mức thành thạo theo chủ đề (Phase 5) - Topic mastery và Knowledge Map. Không gọi mạng/DB nên dễ test.
// Mỗi chủ đề có một bản ghi users/{uid}/topicStats/{topicId} giữ chuỗi kết quả gần nhất, mỗi ký tự là một câu:
//   c = đúng, g = đúng nhưng người học đánh dấu "đoán" (chỉ tính nửa điểm), w = sai.
// Chỉ câu đã chấm đúng/sai mới là bằng chứng. Câu bỏ trống, câu trả lời ngắn (không tự chấm), câu không có chủ đề thì bỏ qua.

export const RECENT_MAX = 30; // chỉ nhớ 30 câu gần nhất của mỗi chủ đề để mức thành thạo phản ánh hiện tại, không bị kéo lùi bởi câu rất cũ
export const MIN_SAMPLE = 5; // dưới 5 câu thì chưa đủ căn cứ để xếp loại
export const GUESS_WEIGHT = 0.5; // đoán trúng chưa chắc đã nắm nên chỉ tính nửa điểm
export const WEAK_BELOW = 0.5; // dưới 50%: cần luyện
export const STRONG_FROM = 0.8; // từ 80%: vững

const UNKNOWN_SUBJECT = 'Chưa phân loại';
const UNKNOWN_CHAPTER = 'Chưa rõ chương';
const cmp = (a, b) => a.localeCompare(b, 'vi');

const cleanRecent = (s) => String(s ?? '').replace(/[^cgw]/g, '').slice(-RECENT_MAX);

// Date, Firestore Timestamp hoặc số ms -> chuỗi ISO
function isoOf(v) {
    const ms = v == null ? null : typeof v === 'number' ? v : v instanceof Date ? v.getTime() : v.toMillis ? v.toMillis() : null;
    return ms == null ? null : new Date(ms).toISOString();
}

// Kết quả một câu -> ký tự, hoặc null nếu không phải bằng chứng
export function outcomeOf(status, confidence) {
    if (status === 'correct') return confidence === 'guess' ? 'g' : 'c';
    if (status === 'wrong') return 'w';
    return null;
}

// Gom kết quả của một lượt làm (hoặc một lượt ôn) theo chủ đề -> Map(topicId -> chuỗi ký tự, theo thứ tự câu)
export function outcomesByTopic(questions, statuses, confidence) {
    const out = new Map();
    for (const q of questions || []) {
        if (q.type === 'short' || !q.topicId) continue;
        const c = outcomeOf(statuses?.[q.id], confidence?.[q.id]);
        if (!c) continue;
        out.set(q.topicId, (out.get(q.topicId) || '') + c);
    }
    return out;
}

// Cộng kết quả mới vào bản ghi cũ (prev có thể là null). Không có createdAt/updatedAt: nơi gọi tự đặt bằng giờ server.
export function applyOutcomes(prev, outcomes, nowMs) {
    const added = cleanRecent(outcomes);
    return {
        recent: cleanRecent(cleanRecent(prev?.recent) + added),
        total: (prev?.total || 0) + added.length,
        lastAt: new Date(nowMs)
    };
}

// Điểm 0..1 của một chuỗi kết quả; null nếu chưa có câu nào
export function scoreOf(recent) {
    const s = cleanRecent(recent);
    if (!s.length) return null;
    let points = 0;
    for (const ch of s) points += ch === 'c' ? 1 : ch === 'g' ? GUESS_WEIGHT : 0;
    return points / s.length;
}

export function levelOf(sample, score) {
    if (!sample || score == null || sample < MIN_SAMPLE) return 'new';
    if (score < WEAK_BELOW) return 'weak';
    if (score < STRONG_FROM) return 'learning';
    return 'strong';
}

// Một chủ đề trong bản đồ. doc: bản ghi topicStats; info: { name, chapter, subject } hoặc undefined nếu chủ đề đã bị xóa.
export function toMasteryItem(doc, info) {
    const recent = cleanRecent(doc?.recent);
    const score = scoreOf(recent);
    return {
        topicId: doc.topicId,
        name: info?.name ?? null,
        chapter: info?.chapter ?? null,
        subject: info?.subject ?? null,
        sample: recent.length,
        answered: doc?.total || recent.length,
        percent: score == null ? null : Math.round(score * 100),
        level: levelOf(recent.length, score),
        lastAt: isoOf(doc?.lastAt)
    };
}

// Tổng hợp nhiều chủ đề: trung bình có trọng số theo số câu gần đây
function rollup(items) {
    const sample = items.reduce((n, t) => n + t.sample, 0);
    const points = items.reduce((n, t) => n + (t.percent == null ? 0 : (t.percent / 100) * t.sample), 0);
    const score = sample ? points / sample : null;
    return { sample, percent: score == null ? null : Math.round(score * 100), level: levelOf(sample, score) };
}

// Môn -> Chương -> Chủ đề. Chủ đề trong chương xếp theo tên; chủ đề yếu nhất cả bản đồ (tối đa `limitWeak`) nằm ở `weakest`
// để nút "Luyện phần yếu" dùng. Chủ đề chưa đủ dữ liệu không bao giờ bị gọi là yếu.
export function buildKnowledgeMap(items, limitWeak = 5) {
    const subjects = new Map();
    for (const t of items) {
        const s = t.subject || UNKNOWN_SUBJECT;
        const c = t.chapter || UNKNOWN_CHAPTER;
        if (!subjects.has(s)) subjects.set(s, new Map());
        const chapters = subjects.get(s);
        if (!chapters.has(c)) chapters.set(c, []);
        chapters.get(c).push(t);
    }

    const map = [...subjects.entries()]
        .sort(([a], [b]) => cmp(a, b))
        .map(([subject, chapters]) => {
            const chapterList = [...chapters.entries()]
                .sort(([a], [b]) => cmp(a, b))
                .map(([chapter, topics]) => ({
                    chapter,
                    ...rollup(topics),
                    topics: [...topics].sort((a, b) => cmp(a.name || '', b.name || ''))
                }));
            return { subject, ...rollup(chapterList.flatMap((c) => c.topics)), chapters: chapterList };
        });

    const weakest = items
        .filter((t) => t.level === 'weak')
        .sort((a, b) => a.percent - b.percent || b.sample - a.sample)
        .slice(0, limitWeak);

    return { map, weakest, counts: countLevels(items) };
}

export function countLevels(items) {
    const out = { new: 0, weak: 0, learning: 0, strong: 0 };
    for (const t of items) out[t.level]++;
    return out;
}

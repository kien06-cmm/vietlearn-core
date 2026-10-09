// Chức năng: luật thuần cho vòng lặp học tập (Phase 5) - sổ lỗi sai, đáp án nhiễu (người học hay chọn nhầm đáp án nào), lịch ôn 1 -> 3 -> 7 ngày điều chỉnh theo đúng/sai và mức tự tin. Không gọi mạng/DB nên dễ test.
// Mỗi câu sai là một bản ghi users/{uid}/mistakes/{questionId}: chụp sẵn đề + đáp án đúng (chỉ backend đọc) để màn ôn tập không phải đọc thêm quiz/version.
import { UNKNOWN_SUBJECT } from './masteryRules.js';

export const REVIEW_INTERVALS_DAYS = [1, 3, 7]; // lịch ôn: sau 1 ngày, rồi 3 ngày, rồi 7 ngày
export const MASTERED_STAGE = REVIEW_INTERVALS_DAYS.length; // qua hết các mốc thì coi là đã nắm
export const MAX_REVIEW_BATCH = 20; // số câu tối đa cho một lần ôn
export const MAX_MISTAKES_LIST = 200; // số câu tối đa trả về cho sổ lỗi sai
const DAY_MS = 86_400_000;

const clampStage = (s) => (Number.isInteger(s) && s >= 0 ? Math.min(s, MASTERED_STAGE - 1) : 0);
const dueAt = (stage, nowMs) => new Date(nowMs + REVIEW_INTERVALS_DAYS[stage] * DAY_MS);

// Date, Firestore Timestamp hoặc số ms -> ms
function msOf(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.getTime();
    return v.toMillis ? v.toMillis() : null;
}
const isoOf = (v) => {
    const ms = msOf(v);
    return ms == null ? null : new Date(ms).toISOString();
};

// ---------------------------------------------------------------------------
// Đáp án nhiễu: những đáp án SAI mà người làm đã chọn (index gốc). Chỉ có nghĩa với câu chọn đáp án.
// ---------------------------------------------------------------------------
export function wrongPicks(type, given, correct) {
    if (type === 'single') return Number.isInteger(given) && given !== correct ? [given] : [];
    if (type === 'multi') {
        const right = new Set(Array.isArray(correct) ? correct : []);
        return Array.isArray(given) ? given.filter((i) => Number.isInteger(i) && !right.has(i)) : [];
    }
    return [];
}

// Đáp án sai bị chọn nhiều nhất của một câu, hoặc null nếu chưa có
export function topWrongOption(doc) {
    let best = null;
    for (const [k, count] of Object.entries(doc?.wrongOptionCounts || {})) {
        const index = Number(k);
        if (!Number.isInteger(index) || !(count > 0)) continue;
        if (!best || count > best.count) best = { index, count, text: doc.options?.[index] ?? '' };
    }
    return best;
}

function addPicks(counts, picks) {
    const out = { ...(counts || {}) };
    for (const i of picks || []) out[String(i)] = (out[String(i)] || 0) + 1;
    return out;
}

// ---------------------------------------------------------------------------
// Tinh chỉnh kiểu sai bằng LỊCH SỬ của chính câu này (một lượt làm riêng lẻ không biết điều này):
//  - chọn lại đúng đáp án sai đã từng chọn = dấu hiệu hiểu nhầm rõ nhất (trừ khi người học tự đánh dấu "Đoán" hoặc hết giờ)
//  - sai lại một câu mà không có tín hiệu nào khác = dấu hiệu chưa nắm kiến thức
// ---------------------------------------------------------------------------
export function refineErrorType(prev, { errorType = null, picks = [] } = {}) {
    const seen = prev?.wrongOptionCounts || {};
    const samePickAgain = (picks || []).some((i) => (seen[String(i)] || 0) > 0);
    if (samePickAgain && errorType !== 'guess' && errorType !== 'timeout') return 'misconception';
    if ((errorType === null || errorType === 'unknown') && (prev?.wrongCount || 0) >= 1) return 'knowledge';
    return errorType ?? prev?.errorType ?? null;
}

// Khi ôn lại mà sai: nếu chọn "Chắc chắn" thì là hiểu nhầm, "Đoán" thì là đoán, còn lại giữ kiểu sai cũ rồi để refineErrorType xem lịch sử
const reviewErrorBase = (doc, confidence) =>
    confidence === 'sure' ? 'misconception' : confidence === 'guess' ? 'guess' : (doc?.errorType ?? null);

// ---------------------------------------------------------------------------
// Ghi nhận một câu sai khi nộp bài. Câu sai lại (kể cả câu đã nắm) thì quay về mốc đầu: ôn lại sau 1 ngày.
// prev: bản ghi cũ (hoặc null). incoming: ảnh chụp câu hỏi + đáp án + kiểu sai gợi ý + các đáp án sai đã chọn.
// Không có createdAt/updatedAt: nơi gọi tự đặt bằng giờ server.
// ---------------------------------------------------------------------------
export function applyWrong(prev, incoming, nowMs) {
    return {
        questionId: incoming.questionId,
        quizId: incoming.quizId ?? null,
        quizVersion: incoming.quizVersion ?? null,
        topicId: incoming.topicId ?? null,
        type: incoming.type,
        stem: incoming.stem,
        options: incoming.options || [],
        correct: incoming.correct ?? null,
        alternatives: incoming.alternatives || [],
        explanation: incoming.explanation || '',
        errorType: refineErrorType(prev, incoming),
        confidence: incoming.confidence ?? null,
        wrongCount: (prev?.wrongCount || 0) + 1,
        reviewCount: prev?.reviewCount || 0,
        wrongOptionCounts: addPicks(prev?.wrongOptionCounts, incoming.picks),
        status: 'open',
        stage: 0,
        nextReviewAt: dueAt(0, nowMs),
        lastWrongAt: new Date(nowMs)
    };
}

// ---------------------------------------------------------------------------
// Lịch ôn theo kết quả một lần ôn:
//  - sai: về mốc đầu (1 ngày)
//  - đúng nhưng "đoán": chưa tính, giữ nguyên mốc
//  - đúng và "phân vân": lên một mốc nhưng chưa được coi là đã nắm (mốc cuối ôn thêm một lần)
//  - đúng (chắc chắn hoặc không đánh dấu): lên một mốc; qua mốc cuối là đã nắm
// ---------------------------------------------------------------------------
export function nextStage({ stage, status, confidence }) {
    const cur = clampStage(stage);
    if (status !== 'correct') return { stage: 0, mastered: false };
    if (confidence === 'guess') return { stage: cur, mastered: false };
    const advanced = cur + 1;
    if (advanced < MASTERED_STAGE) return { stage: advanced, mastered: false };
    if (confidence === 'unsure') return { stage: MASTERED_STAGE - 1, mastered: false };
    return { stage: MASTERED_STAGE, mastered: true };
}

// Các trường cần cập nhật sau một lần ôn. status: 'correct' | 'wrong'
export function applyReview(doc, { status, confidence = null, picks = [] }, nowMs) {
    const next = nextStage({ stage: doc?.stage, status, confidence });
    return {
        stage: next.stage,
        status: next.mastered ? 'mastered' : 'open',
        nextReviewAt: next.mastered ? null : dueAt(next.stage, nowMs),
        reviewCount: (doc?.reviewCount || 0) + 1,
        wrongCount: (doc?.wrongCount || 0) + (status === 'wrong' ? 1 : 0),
        wrongOptionCounts: status === 'wrong' ? addPicks(doc?.wrongOptionCounts, picks) : doc?.wrongOptionCounts || {},
        ...(status === 'wrong' ? { errorType: refineErrorType(doc, { errorType: reviewErrorBase(doc, confidence), picks }) } : {}),
        lastReviewedAt: new Date(nowMs),
        lastResult: status
    };
}

// ---------------------------------------------------------------------------
// Dạng gửi cho giao diện
// ---------------------------------------------------------------------------

// Câu hỏi để ôn: KHÔNG có đáp án đúng, giải thích hay kiểu sai
export function toReviewQuestion(doc) {
    return {
        id: doc.questionId,
        type: doc.type,
        stem: doc.stem,
        options: (doc.options || []).map((text, index) => ({ index, text })),
        topicId: doc.topicId ?? null,
        stage: doc.stage ?? 0
    };
}

// Một dòng trong sổ lỗi sai (người học đã thấy đáp án sau khi nộp bài nên sổ được hiện kèm đáp án đúng)
export function toListItem(doc, topicNames = {}) {
    return {
        id: doc.questionId,
        type: doc.type,
        stem: doc.stem,
        options: (doc.options || []).map((text, index) => ({ index, text })),
        topicId: doc.topicId ?? null,
        topicName: topicNames[doc.topicId]?.name ?? null,
        status: doc.status,
        stage: doc.stage ?? 0,
        errorType: doc.errorType ?? null,
        confidence: doc.confidence ?? null,
        wrongCount: doc.wrongCount || 0,
        reviewCount: doc.reviewCount || 0,
        topWrong: topWrongOption(doc),
        nextReviewAt: isoOf(doc.nextReviewAt),
        lastWrongAt: isoOf(doc.lastWrongAt),
        lastReviewedAt: isoOf(doc.lastReviewedAt),
        correct: doc.correct ?? null,
        alternatives: doc.alternatives || [],
        explanation: doc.explanation || ''
    };
}

// Tổng hợp các câu đang ôn: số câu theo kiểu sai (gợi ý) và các chủ đề có nhiều câu sai nhất
export function summarizeMistakes(docs, limitTopics = 5) {
    const byErrorType = {};
    const topics = new Map();
    for (const d of docs) {
        if (d.errorType) byErrorType[d.errorType] = (byErrorType[d.errorType] || 0) + 1;
        const key = d.topicId || '';
        const t = topics.get(key) || { topicId: key || null, mistakes: 0, wrongTotal: 0 };
        t.mistakes++;
        t.wrongTotal += d.wrongCount || 0;
        topics.set(key, t);
    }
    const weakTopics = [...topics.values()].sort((a, b) => b.mistakes - a.mistakes || b.wrongTotal - a.wrongTotal).slice(0, limitTopics);
    return { total: docs.length, byErrorType, weakTopics };
}

// ---------------------------------------------------------------------------
// Theo môn (bộ lọc ở màn Ôn tập). Môn lấy từ chủ đề của câu; câu không có chủ đề hoặc chủ đề không có môn đều vào "Chưa phân loại" (khớp Knowledge Map).
// topicNames: { [topicId]: { subject, chapter, name } }
// ---------------------------------------------------------------------------
export const subjectOfTopic = (topicNames, topicId) => topicNames?.[topicId]?.subject || UNKNOWN_SUBJECT;

// Số câu đang ôn và số câu đã đến hạn theo từng môn; môn có nhiều câu đến hạn nhất lên đầu
export function subjectCounts(docs, topicNames, nowMs) {
    const map = new Map();
    for (const d of docs || []) {
        const subject = subjectOfTopic(topicNames, d.topicId);
        const e = map.get(subject) || { subject, open: 0, due: 0 };
        e.open++;
        const at = msOf(d.nextReviewAt);
        if (at != null && at <= nowMs) e.due++;
        map.set(subject, e);
    }
    return [...map.values()].sort((a, b) => b.due - a.due || b.open - a.open || a.subject.localeCompare(b.subject, 'vi'));
}

// Giữ các câu thuộc môn đã chọn
export const filterBySubject = (docs, topicNames, subject) => (docs || []).filter((d) => subjectOfTopic(topicNames, d.topicId) === subject);

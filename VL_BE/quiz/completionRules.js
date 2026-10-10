// Chức năng: luật thuần cho "chủ đề đã ôn xong" (Phase 5) - khi mọi câu sai của một chủ đề đều đã nắm, người học xem tổng quan rồi chọn
// "Hoàn thành" (lưu trữ, tự xóa sau một thời gian) hoặc "Ôn lại" (đưa câu về mốc đầu). Không gọi mạng/DB nên dễ test.
// Dữ liệu là bản ghi users/{uid}/mistakes/{questionId} (xem quiz/learningRules.js). Trạng thái thêm: 'archived' = đã hoàn thành, không hiện nữa.
// Hết hạn: trường expireAt (Timestamp). Dự án chưa bật thanh toán nên không dùng được chính sách TTL của Firestore; thay vào đó backend tự dọn
// các bản ghi hết hạn của từng người dùng khi họ mở trang Ôn tập (xem purgeExpired trong mistakes.js).

export const HARD_WRONG_COUNT = 2; // sai từ 2 lần trở lên là "câu khó"
export const ARCHIVE_TTL_DAYS = 90; // câu đã hoàn thành tự xóa sau 90 ngày
export const MASTERED_TTL_DAYS = 180; // câu đã nắm mà người học không bấm gì cũng tự xóa sau 180 ngày (sổ không phình mãi)
export const MAX_FINISHED_TOPICS = 20; // số chủ đề tối đa hiện trong danh sách "đã ôn xong"
export const MAX_HARDEST = 3; // số câu khó nhất hiện trong tổng quan
export const NO_TOPIC = '_none'; // khóa cho các câu không gắn chủ đề
const DAY_MS = 86_400_000;

export const topicKey = (topicId) => topicId || NO_TOPIC;

// Bản ghi có được xóa vì hết hạn chưa: có expireAt đã qua và không phải câu đang ôn (câu đang ôn không bao giờ bị xóa dù dữ liệu có sót expireAt)
export function isPurgeable(doc, nowMs) {
    const v = doc?.expireAt;
    const ms = v?.toMillis ? v.toMillis() : v instanceof Date ? v.getTime() : null;
    return ms != null && ms <= nowMs && doc.status !== 'open';
}

export const expireIn = (days, nowMs) => new Date(nowMs + days * DAY_MS);

export const isHard = (doc) => (doc?.wrongCount || 0) >= HARD_WRONG_COUNT;

// Gom các bản ghi theo chủ đề -> Map(khóa chủ đề -> mảng bản ghi). Giữ thứ tự xuất hiện.
export function groupByTopic(docs) {
    const out = new Map();
    for (const d of docs || []) {
        const key = topicKey(d.topicId);
        if (!out.has(key)) out.set(key, []);
        out.get(key).push(d);
    }
    return out;
}

// Tổng quan một chủ đề đã ôn xong (docs: các câu đã nắm của chủ đề đó)
export function summarizeFinished(docs) {
    const list = docs || [];
    const hardest = list
        .filter(isHard)
        .sort((a, b) => (b.wrongCount || 0) - (a.wrongCount || 0))
        .slice(0, MAX_HARDEST)
        .map((d) => ({ id: d.questionId, stem: d.stem, wrongCount: d.wrongCount || 0 }));
    return {
        questions: list.length,
        hard: list.filter(isHard).length,
        wrongTotal: list.reduce((n, d) => n + (d.wrongCount || 0), 0),
        reviewTotal: list.reduce((n, d) => n + (d.reviewCount || 0), 0),
        hardest
    };
}

// Câu nào được ôn lại: scope 'hard' = chỉ câu khó (mặc định), 'all' = tất cả
export const restartTargets = (docs, scope) => (scope === 'all' ? [...(docs || [])] : (docs || []).filter(isHard));

// Hoàn thành: lưu trữ, hết hạn sau ARCHIVE_TTL_DAYS
export const archivePatch = (nowMs) => ({
    status: 'archived',
    expireAt: expireIn(ARCHIVE_TTL_DAYS, nowMs),
    archivedAt: new Date(nowMs)
});

// Ôn lại: mở lại ở mốc đầu và đến hạn ngay, hủy hẹn xóa
export const restartPatch = (nowMs) => ({
    status: 'open',
    stage: 0,
    nextReviewAt: new Date(nowMs),
    expireAt: null
});

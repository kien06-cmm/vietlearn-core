// Chức năng: luật chọn job từ hàng đợi (hàm thuần, dễ test).
// Các loại job gọi Gemini: khi hệ thống đang tạm nghỉ vì Gemini báo 429, worker không nhận các job này (job khác vẫn chạy).
export const AI_JOB_TYPES = ['generate_questions', 'generate_practice'];

// docs: danh sách document Firestore có .data(). Trả các job đã đến giờ chạy (runAfter <= nowMs) và không nằm trong excludeTypes,
// sắp theo runAfter tăng dần. Job thiếu runAfter coi như chạy được ngay.
export function selectReady(docs, nowMs, excludeTypes = []) {
    const runAt = (d) => d.data().runAfter?.toMillis?.() ?? 0;
    return docs
        .filter((d) => !excludeTypes.includes(d.data().type) && runAt(d) <= nowMs)
        .sort((a, b) => runAt(a) - runAt(b));
}

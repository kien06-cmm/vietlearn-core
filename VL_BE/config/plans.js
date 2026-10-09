// Chức năng: giới hạn theo gói (dung lượng file, số tài liệu, số trang, AI credits mỗi ngày và mỗi tuần; 1 credit = 1 câu hỏi được tạo).
// aiCreditsPerDay là số tạm, chỉnh theo chi phí AI thực tế sau khi đo ở staging. Tất cả người dùng chung 1 key Gemini miễn phí nên (số người dùng mỗi ngày x credits) phải nằm trong hạn mức request/ngày của key.
// Hạn mức chỉ tính theo NGÀY (làm mới 0h giờ Việt Nam). Muốn thêm hạn mức tuần thì thêm aiCreditsPerWeek vào gói, credits.js sẽ tự áp dụng.
const MB = 1024 * 1024;

export const PLANS = {
    free: { maxFileBytes: 10 * MB, maxDocuments: 20, maxPages: 100, aiCreditsPerDay: 10, maxQuestionsPerJob: 10, maxImportQuestions: 20 },
    pro: { maxFileBytes: 50 * MB, maxDocuments: 200, maxPages: 500, aiCreditsPerDay: 40, maxQuestionsPerJob: 40, maxImportQuestions: 200 }
};

// Hạn mức credits của một gói, dạng { daily, weekly } cho credits.js
export const creditLimits = (plan) => ({ daily: plan.aiCreditsPerDay, weekly: plan.aiCreditsPerWeek ?? null });

// Chi phí AI credits cho từng thao tác (tạo câu hỏi tính theo số câu: 1 credit = 1 câu, xem routes/questions.js)
export const CREDIT_COST = { summary: 3, ask: 1 };

export function getPlan(name) {
    return PLANS[name] || PLANS.free;
}

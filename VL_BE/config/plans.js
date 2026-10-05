// Chức năng: giới hạn theo gói (dung lượng file, số tài liệu, số trang, AI credits mỗi tháng; 1 credit = 1 câu hỏi được tạo).
// aiCreditsPerMonth là số tạm, chỉnh theo chi phí AI thực tế sau khi đo ở staging.
const MB = 1024 * 1024;

export const PLANS = {
    free: { maxFileBytes: 10 * MB, maxDocuments: 20, maxPages: 100, aiCreditsPerMonth: 30, maxQuestionsPerJob: 20 },
    pro: { maxFileBytes: 50 * MB, maxDocuments: 200, maxPages: 500, aiCreditsPerMonth: 500, maxQuestionsPerJob: 50 }
};

export function getPlan(name) {
    return PLANS[name] || PLANS.free;
}

// Chức năng: giới hạn theo gói (dung lượng file, số tài liệu, số trang).
const MB = 1024 * 1024;

export const PLANS = {
    free: { maxFileBytes: 10 * MB, maxDocuments: 20, maxPages: 100 },
    pro: { maxFileBytes: 50 * MB, maxDocuments: 200, maxPages: 500 }
};

export function getPlan(name) {
    return PLANS[name] || PLANS.free;
}

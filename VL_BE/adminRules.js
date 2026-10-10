// Chức năng: luật thuần cho trang Admin (Phase 6) - chuẩn hóa email tìm kiếm, chọn gói hợp lệ, đổi hồ sơ Firestore thành dữ liệu trả về cho giao diện Admin. Không gọi mạng/DB nên dễ test.
import { PLANS } from './config/plans.js';

export const PLAN_NAMES = Object.keys(PLANS); // ['free', 'pro']

// Email trong Firebase luôn viết thường; bỏ khoảng trắng đầu/cuối. Trả về '' nếu không giống email.
export function normalizeEmail(value) {
    const email = String(value ?? '').trim().toLowerCase();
    return email.length <= 254 && /^[^\s@]+@[^\s@]+$/.test(email) ? email : '';
}

export const isValidPlan = (name) => PLAN_NAMES.includes(name);

const iso = (v) => {
    const ms = v?.toMillis ? v.toMillis() : v instanceof Date ? v.getTime() : null;
    return ms == null ? null : new Date(ms).toISOString();
};

// Hồ sơ users/{uid} -> dữ liệu cho Admin xem (không có gì nhạy cảm ngoài email, vì chỉ admin gọi được)
export function toAdminUser(uid, data) {
    return {
        uid,
        email: data.email ?? null,
        displayName: data.displayName ?? '',
        plan: isValidPlan(data.plan) ? data.plan : 'free',
        isAdmin: data.isAdmin === true,
        deleted: !!data.deletedAt,
        createdAt: iso(data.createdAt)
    };
}

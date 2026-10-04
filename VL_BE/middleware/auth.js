// Chức năng: kiểm tra token Firebase. requireAuth chặn request chưa đăng nhập; optionalAuth cho phép khách.
import { getAdminAuth } from '../firebase.js';

export function readToken(req) {
    const header = req.headers.authorization || '';
    return header.startsWith('Bearer ') ? header.slice(7) : null;
}

// Bắt buộc đăng nhập: gắn người dùng vào req.user
export async function requireAuth(req, res, next) {
    const token = readToken(req);

    if (!token) {
        return res.status(401).json({ status: 'error', message: 'Thiếu token đăng nhập' });
    }

    const adminAuth = getAdminAuth();

    try {
        req.user = await adminAuth.verifyIdToken(token);
        next();
    } catch {
        res.status(401).json({ status: 'error', message: 'Token không hợp lệ hoặc đã hết hạn' });
    }
}

// Không bắt buộc đăng nhập: có token hợp lệ thì gắn req.user, không thì coi là khách
export async function optionalAuth(req, res, next) {
    const token = readToken(req);
    if (!token) return next();

    try {
        req.user = await getAdminAuth().verifyIdToken(token);
    } catch {
        // Token sai/hết hạn: bỏ qua, xử lý như khách
    }
    next();
}

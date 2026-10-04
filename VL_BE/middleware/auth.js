// Chức năng: chặn request chưa đăng nhập, kiểm tra token Firebase và gắn người dùng vào req.user.
import { getAdminAuth } from '../firebase.js';

export async function requireAuth(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;

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

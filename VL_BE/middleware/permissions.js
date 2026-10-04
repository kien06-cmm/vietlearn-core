// Chức năng: phân quyền theo resource/context (owner, admin, guest, và vai trò theo ngữ cảnh như host/participant của phòng).
//
// Cách dùng:
//   app.get('/admin/x', requireAdmin, handler)
//   app.get('/users/:uid', requireOwner((req) => req.params.uid), handler)
//   // Phase 4: vai trò theo phòng
//   app.post('/rooms/:roomId/start', requireRole(['host'], getRoomRoles), handler)
//   (getRoomRoles(req) trả về mảng vai trò của req.actor trong phòng, vd ['host'] hoặc ['participant'])
import { getAdminAuth, getDb } from '../firebase.js';
import { readToken } from './auth.js';
import { findGuestSession } from '../guestSessions.js';

function deny(res, status = 403, message = 'Bạn không có quyền thực hiện thao tác này') {
    return res.status(status).json({ status: 'error', message });
}

// Xác định "ai đang gọi": người dùng (Authorization: Bearer <Firebase token>) hoặc khách (Authorization: Guest <token>).
// Gắn req.actor = { type: 'user' | 'guest', id, ... }. Người dùng còn có req.user (token đã giải mã) và req.profile.
export async function requireActor(req, res, next) {
    const header = req.headers.authorization || '';

    if (header.startsWith('Guest ')) {
        const session = await findGuestSession(header.slice(6));
        if (!session) return deny(res, 401, 'Phiên khách không hợp lệ hoặc đã hết hạn');
        req.actor = { type: 'guest', id: session.guestId, displayName: session.displayName };
        return next();
    }

    const token = readToken(req);
    if (!token) return deny(res, 401, 'Thiếu token đăng nhập');

    let decoded;
    try {
        decoded = await getAdminAuth().verifyIdToken(token);
    } catch {
        return deny(res, 401, 'Token không hợp lệ hoặc đã hết hạn');
    }

    // Quyền (isAdmin) luôn đọc từ Firestore, không tin dữ liệu do client gửi
    const snap = await getDb().collection('users').doc(decoded.uid).get();
    if (!snap.exists || snap.data().deletedAt) {
        return deny(res, 403, 'Tài khoản không tồn tại hoặc đã bị xóa');
    }

    req.user = decoded;
    req.profile = snap.data();
    req.actor = { type: 'user', id: decoded.uid };
    next();
}

// Kiểm tra vai trò. Vai trò mặc định: 'user' hoặc 'guest' (theo loại actor), thêm 'admin' nếu isAdmin.
// resolveRoles(req) (tùy chọn) trả về thêm vai trò theo resource/context, vd ['owner'], ['host'].
export function checkRole(allowed, resolveRoles) {
    return async function checkRoleMiddleware(req, res, next) {
        const roles = new Set([req.actor.type]);
        if (req.actor.type === 'user' && req.profile?.isAdmin === true) roles.add('admin');
        if (resolveRoles) {
            for (const role of await resolveRoles(req)) roles.add(role);
        }

        if (allowed.some((role) => roles.has(role))) return next();
        deny(res);
    };
}

export function requireRole(allowed, resolveRoles) {
    return [requireActor, checkRole(allowed, resolveRoles)];
}

// Vai trò 'owner' nếu actor là người dùng và là chủ resource. getOwnerUid(req) trả về uid chủ (hoặc null).
export function ownerRoles(getOwnerUid) {
    return async (req) => {
        if (req.actor.type !== 'user') return [];
        const ownerUid = await getOwnerUid(req);
        return ownerUid != null && ownerUid === req.actor.id ? ['owner'] : [];
    };
}

// Chỉ admin
export const requireAdmin = requireRole(['admin']);

// Chủ resource hoặc admin
export function requireOwner(getOwnerUid) {
    return requireRole(['owner', 'admin'], ownerRoles(getOwnerUid));
}

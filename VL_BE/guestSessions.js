// Chức năng: phiên khách (guest session) - token tạm cho người vào phòng mà không cần tài khoản.
// Token gốc chỉ trả cho khách 1 lần; Firestore chỉ lưu bản băm (SHA-256) nên lộ DB cũng không dùng được token.
import crypto from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from './firebase.js';

export const GUEST_TTL_MS = 12 * 60 * 60 * 1000; // phiên khách sống 12 giờ

function hashToken(token) {
    return crypto.createHash('sha256').update(token).digest('hex');
}

// Tạo phiên khách mới: guestSessions/{sha256(token)}
export async function createGuestSession(displayName) {
    const token = crypto.randomBytes(32).toString('base64url');
    const guestId = `g_${crypto.randomBytes(8).toString('hex')}`;
    const expiresAt = new Date(Date.now() + GUEST_TTL_MS);

    await getDb().collection('guestSessions').doc(hashToken(token)).set({
        guestId,
        displayName,
        roomId: null,
        createdAt: FieldValue.serverTimestamp(),
        expiresAt
    });

    return { token, guest: { id: guestId, displayName, expiresAt: expiresAt.toISOString() } };
}

// Tìm phiên khách theo token. Trả về null nếu không có hoặc đã hết hạn.
export async function findGuestSession(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;

    const snap = await getDb().collection('guestSessions').doc(hashToken(token)).get();
    if (!snap.exists) return null;

    const data = snap.data();
    const expiresAt = data.expiresAt.toDate();
    if (expiresAt.getTime() <= Date.now()) return null;

    return { guestId: data.guestId, displayName: data.displayName, roomId: data.roomId, expiresAt };
}

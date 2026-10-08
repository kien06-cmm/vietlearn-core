// Chức năng: máy chủ WebSocket cho phòng làm bài (Phase 4) - địa chỉ /ws, cùng cổng với API.
// Giao thức: client mở kết nối rồi gửi ngay { type: 'auth', auth: 'Bearer <token>' | 'Guest <token>', code }.
// Server kiểm tra token và vai trò trong phòng (chủ phòng hoặc người đã vào phòng) rồi trả { type: 'ready', role }.
// Sau đó server chỉ đẩy { type: 'room', room } và { type: 'participant', participant } (xem roomHub.js). Client không gửi gì khác ngoài { type: 'ping' }.
// Mã đóng: 4001 xác thực lỗi · 4003 sai nguồn (origin) · 4004 không có phòng hoặc chưa vào phòng · 4008 quá tải. Client không tự nối lại với mã 4xxx.
import { WebSocketServer } from 'ws';
import { getAdminAuth, getDb } from '../firebase.js';
import { findGuestSession } from '../guestSessions.js';
import { normalizeCode, participantKey } from '../quiz/roomRules.js';
import { hub } from './roomHub.js';

const AUTH_TIMEOUT_MS = 5000;
const PING_MS = 30_000;
const MAX_SOCKETS = 2000;
const MAX_MESSAGES_PER_10S = 20;
const OPEN = 1;

// Giống requireActor ở middleware/permissions.js nhưng nhận chuỗi Authorization từ tin nhắn đầu tiên (trình duyệt không gắn được header cho WebSocket)
async function actorFromAuth(auth) {
    if (typeof auth !== 'string' || auth.length > 4096) return null;

    if (auth.startsWith('Guest ')) {
        const session = await findGuestSession(auth.slice(6));
        return session ? { type: 'guest', id: session.guestId } : null;
    }

    if (auth.startsWith('Bearer ')) {
        let decoded;
        try {
            decoded = await getAdminAuth().verifyIdToken(auth.slice(7));
        } catch {
            return null;
        }
        const snap = await getDb().collection('users').doc(decoded.uid).get();
        if (!snap.exists || snap.data().deletedAt) return null;
        return { type: 'user', id: decoded.uid };
    }

    return null;
}

// Chủ phòng là 'host'; người đã vào phòng là 'participant'; người khác không có quyền (null)
async function roleIn(code, actor) {
    const roomRef = getDb().collection('rooms').doc(code);
    const [room, part] = await Promise.all([roomRef.get(), roomRef.collection('participants').doc(participantKey(actor)).get()]);
    if (!room.exists) return null;
    if (actor.type === 'user' && room.data().hostId === actor.id) return 'host';
    return part.exists ? 'participant' : null;
}

export function attachRealtime(server) {
    const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });
    const origins = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()) : null;

    wss.on('connection', (ws, req) => {
        const origin = req.headers.origin;
        if (origins && origin && !origins.includes(origin)) return ws.close(4003, 'origin');
        if (wss.clients.size > MAX_SOCKETS) return ws.close(4008, 'busy');

        ws.isAlive = true;
        ws.on('pong', () => {
            ws.isAlive = true;
        });

        let client = null;
        let code = null;
        let authed = false;
        let authing = false;
        let messages = 0;

        const authTimer = setTimeout(() => {
            if (!authed) ws.close(4001, 'auth-timeout');
        }, AUTH_TIMEOUT_MS);
        const rateTimer = setInterval(() => {
            messages = 0;
        }, 10_000);

        ws.on('message', async (data) => {
            if (++messages > MAX_MESSAGES_PER_10S) return ws.close(4008, 'rate');

            let msg;
            try {
                msg = JSON.parse(data.toString());
            } catch {
                return;
            }
            if (msg?.type === 'ping') {
                if (ws.readyState === OPEN) ws.send('{"type":"pong"}');
                return;
            }
            if (msg?.type !== 'auth' || authed || authing) return;

            authing = true;
            try {
                const roomCode = normalizeCode(msg.code);
                const actor = roomCode ? await actorFromAuth(msg.auth) : null;
                if (!actor) return ws.close(4001, 'auth');

                const role = await roleIn(roomCode, actor);
                if (!role) return ws.close(4004, 'no-room');
                if (ws.readyState !== OPEN) return; // đã đóng trong lúc kiểm tra

                const entry = { ws, role, key: participantKey(actor) };
                if (!hub.add(roomCode, entry)) return ws.close(4008, 'full');

                client = entry;
                code = roomCode;
                authed = true;
                clearTimeout(authTimer);
                ws.send(JSON.stringify({ type: 'ready', role }));
            } catch {
                ws.close(1011, 'error');
            } finally {
                authing = false;
            }
        });

        ws.on('close', () => {
            clearTimeout(authTimer);
            clearInterval(rateTimer);
            if (client && code) hub.remove(code, client);
        });
        ws.on('error', () => {});
    });

    // Dọn kết nối chết (mất mạng không báo đóng): mỗi chu kỳ ping, ai không trả lời pong từ chu kỳ trước thì ngắt
    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
            if (!ws.isAlive) {
                ws.terminate();
                continue;
            }
            ws.isAlive = false;
            ws.ping();
        }
    }, PING_MS);
    wss.on('close', () => clearInterval(heartbeat));

    return wss;
}

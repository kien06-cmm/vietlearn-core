// Chức năng: hub realtime cho phòng làm bài (Phase 4) - nhớ ai đang nối WebSocket vào phòng nào và đẩy tin cho họ. Không gọi mạng/DB nên dễ test.
// Chỉ đẩy "thay đổi" (phòng đổi trạng thái, người tham gia đổi tiến độ). Dữ liệu gốc vẫn nằm ở Firestore và lấy bằng REST.
// Hub nằm trong bộ nhớ của MỘT tiến trình: chạy một instance API trên Render. Muốn chạy nhiều instance thì cần thêm kênh chung (Redis pub/sub).

const OPEN = 1; // WebSocket.OPEN

export const MAX_CLIENTS_PER_ROOM = 400;

export function createHub() {
    const rooms = new Map(); // code -> Set<client>; client = { ws, role: 'host' | 'participant', key }

    function safeSend(client, text) {
        try {
            if (client.ws.readyState === OPEN) client.ws.send(text);
        } catch {
            // socket hỏng: lần ping sau sẽ bị dọn
        }
    }

    // Trả false nếu phòng đã đầy kết nối
    function add(code, client) {
        let set = rooms.get(code);
        if (!set) {
            set = new Set();
            rooms.set(code, set);
        }
        if (set.size >= MAX_CLIENTS_PER_ROOM) return false;
        set.add(client);
        return true;
    }

    function remove(code, client) {
        const set = rooms.get(code);
        if (!set) return;
        set.delete(client);
        if (set.size === 0) rooms.delete(code);
    }

    function send(code, msg, filter = () => true) {
        const set = rooms.get(code);
        if (!set) return 0;
        const text = JSON.stringify(msg);
        let n = 0;
        for (const client of set) {
            if (!filter(client)) continue;
            safeSend(client, text);
            n++;
        }
        return n;
    }

    return {
        add,
        remove,
        size: (code) => rooms.get(code)?.size ?? 0,
        totalRooms: () => rooms.size,

        // Phòng đổi trạng thái hoặc số người: chủ phòng nhận bản đầy đủ, người tham gia nhận bản công khai
        publishRoom(code, publicRoom, hostRoom) {
            send(code, { type: 'room', room: hostRoom }, (c) => c.role === 'host');
            send(code, { type: 'room', room: publicRoom }, (c) => c.role !== 'host');
        },

        // Người tham gia vào phòng hoặc đổi tiến độ: chỉ chủ phòng cần biết. participant có thể chỉ là phần thay đổi (luôn có key).
        publishParticipant(code, participant) {
            send(code, { type: 'participant', participant }, (c) => c.role === 'host');
        }
    };
}

export const hub = createHub();

// Gọi từ route: lỗi đẩy tin không bao giờ được làm hỏng thao tác chính (dữ liệu đã lưu xong)
export function safePublish(fn) {
    try {
        fn();
    } catch (err) {
        console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', message: `realtime: ${err.message}` }));
    }
}

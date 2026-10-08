// Chức năng: kiểm thử hub realtime của phòng và dữ liệu tiến độ người tham gia (không gọi mạng/DB). Chạy: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_CLIENTS_PER_ROOM, createHub, safePublish } from '../realtime/roomHub.js';
import { countParticipants, participantView, progressOfSubmitted, PROGRESS_IN_PROGRESS, PROGRESS_WAITING } from '../quiz/roomRules.js';

// Socket giả: ghi lại các tin đã gửi
function fakeWs(readyState = 1) {
    return {
        readyState,
        sent: [],
        send(text) {
            this.sent.push(JSON.parse(text));
        }
    };
}

const client = (role, ws = fakeWs()) => ({ ws, role, key: `${role}_x` });

test('tin phòng: chủ phòng nhận bản đầy đủ, người tham gia nhận bản công khai', () => {
    const hub = createHub();
    const host = client('host');
    const p1 = client('participant');
    hub.add('ABC234', host);
    hub.add('ABC234', p1);

    hub.publishRoom('ABC234', { code: 'ABC234', status: 'RUNNING' }, { code: 'ABC234', status: 'RUNNING', quizId: 'q1' });

    assert.deepEqual(host.ws.sent, [{ type: 'room', room: { code: 'ABC234', status: 'RUNNING', quizId: 'q1' } }]);
    assert.deepEqual(p1.ws.sent, [{ type: 'room', room: { code: 'ABC234', status: 'RUNNING' } }]);
});

test('thông tin chủ phòng (quizId, version) không lọt sang người tham gia', () => {
    const hub = createHub();
    const p1 = client('participant');
    hub.add('ABC234', p1);
    hub.publishRoom('ABC234', { code: 'ABC234' }, { code: 'ABC234', quizId: 'bi-mat', version: 3 });
    assert.ok(!JSON.stringify(p1.ws.sent).includes('bi-mat'));
});

test('tiến độ người tham gia chỉ gửi cho chủ phòng', () => {
    const hub = createHub();
    const host = client('host');
    const p1 = client('participant');
    hub.add('ABC234', host);
    hub.add('ABC234', p1);

    hub.publishParticipant('ABC234', { key: 'guest_g1', status: 'submitted', score10: 8 });

    assert.equal(host.ws.sent.length, 1);
    assert.equal(host.ws.sent[0].participant.score10, 8);
    assert.equal(p1.ws.sent.length, 0);
});

test('tin chỉ tới đúng phòng', () => {
    const hub = createHub();
    const a = client('host');
    const b = client('host');
    hub.add('AAAAAA', a);
    hub.add('BBBBBB', b);
    hub.publishParticipant('AAAAAA', { key: 'k' });
    assert.equal(a.ws.sent.length, 1);
    assert.equal(b.ws.sent.length, 0);
});

test('ngắt kết nối thì không nhận tin nữa và phòng trống được dọn', () => {
    const hub = createHub();
    const host = client('host');
    hub.add('ABC234', host);
    assert.equal(hub.size('ABC234'), 1);
    hub.remove('ABC234', host);
    hub.publishParticipant('ABC234', { key: 'k' });
    assert.equal(host.ws.sent.length, 0);
    assert.equal(hub.size('ABC234'), 0);
    assert.equal(hub.totalRooms(), 0);
});

test('socket đã đóng hoặc gửi lỗi không làm hỏng việc gửi cho người khác', () => {
    const hub = createHub();
    const closed = client('host', fakeWs(3));
    const broken = client('host', {
        readyState: 1,
        send() {
            throw new Error('socket hỏng');
        }
    });
    const ok = client('host');
    hub.add('ABC234', closed);
    hub.add('ABC234', broken);
    hub.add('ABC234', ok);

    hub.publishParticipant('ABC234', { key: 'k' });

    assert.equal(closed.ws.sent.length, 0);
    assert.equal(ok.ws.sent.length, 1);
});

test('mỗi phòng có giới hạn số kết nối', () => {
    const hub = createHub();
    for (let i = 0; i < MAX_CLIENTS_PER_ROOM; i++) assert.equal(hub.add('ABC234', client('participant')), true);
    assert.equal(hub.add('ABC234', client('participant')), false);
    assert.equal(hub.add('XYZ789', client('participant')), true); // phòng khác không bị ảnh hưởng
});

test('safePublish nuốt lỗi để không làm hỏng thao tác chính', (t) => {
    t.mock.method(console, 'error', () => {});
    assert.doesNotThrow(() =>
        safePublish(() => {
            throw new Error('lỗi đẩy tin');
        })
    );
});

// ---------------------------------------------------------------------------
// Tiến độ người tham gia
// ---------------------------------------------------------------------------
test('tiến độ khi nộp bài lấy điểm từ kết quả chấm', () => {
    const p = progressOfSubmitted({ correct: 7, gradable: 10, score10: 7 }, 'timeout');
    assert.deepEqual(p, { status: 'submitted', correct: 7, gradable: 10, score10: 7, submitReason: 'timeout' });
    assert.equal(progressOfSubmitted(null, null).score10, null);
    assert.equal(PROGRESS_WAITING.status, 'waiting');
    assert.equal(PROGRESS_IN_PROGRESS.status, 'in_progress');
});

test('bản ghi người tham gia cũ chưa có tiến độ được coi là đang chờ', () => {
    const v = participantView('guest_g1', { type: 'guest', displayName: 'Minh', joinedAt: new Date('2026-10-08T01:00:00Z') });
    assert.equal(v.status, 'waiting');
    assert.equal(v.score10, null);
    assert.equal(v.key, 'guest_g1');
    assert.equal(v.joinedAt, '2026-10-08T01:00:00.000Z');
});

test('thời gian vào phòng đọc được cả dạng Firestore Timestamp', () => {
    const v = participantView('user_u1', { type: 'user', displayName: 'Cô Lan', joinedAt: { toMillis: () => Date.parse('2026-10-08T02:30:00Z') } });
    assert.equal(v.joinedAt, '2026-10-08T02:30:00.000Z');
});

test('đếm người theo trạng thái', () => {
    const list = [{ status: 'waiting' }, { status: 'in_progress' }, { status: 'in_progress' }, { status: 'submitted' }];
    assert.deepEqual(countParticipants(list), { joined: 4, inProgress: 2, submitted: 1 });
    assert.deepEqual(countParticipants([]), { joined: 0, inProgress: 0, submitted: 0 });
});

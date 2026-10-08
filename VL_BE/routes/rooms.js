// Chức năng: API phòng làm bài (Phase 4) - chủ quiz tạo phòng từ quiz đã publish, người tham gia (tài khoản hoặc khách) vào bằng mã phòng, chủ phòng bắt đầu/kết thúc, ai cũng xem được trạng thái phòng (màn chờ hỏi định kỳ).
// Trạng thái do server quyết định: WAITING -> RUNNING -> ENDED. Phòng kết thúc thì mọi lượt làm đang dở trong phòng được nộp tự động.
// Mã phòng cũng là id của document rooms/{code}. Người tham gia: rooms/{code}/participants/{type_id}.
// Làm bài trong phòng dùng POST /attempts/room (routes/attempts.js).
import { Router } from 'express';
import { z } from 'zod';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../firebase.js';
import { requireRole } from '../middleware/permissions.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { finalizeAttempt } from './attempts.js';
import { hub, safePublish } from '../realtime/roomHub.js';
import {
    DEFAULT_MAX_PARTICIPANTS,
    MAX_ACTIVE_ROOMS_PER_HOST,
    MAX_PARTICIPANTS_LIMIT,
    PROGRESS_WAITING,
    ROOM_MODES,
    ROOM_STATUS,
    ROOM_TTL_MS,
    canTransition,
    countParticipants,
    effectiveStatus,
    generateCode,
    normalizeCode,
    participantKey,
    participantView,
    roomModeConfig
} from '../quiz/roomRules.js';

const router = Router();
const anyActor = requireRole(['user', 'guest']);
const userOnly = requireRole(['user']);

const rooms = () => getDb().collection('rooms');
const attempts = () => getDb().collection('attempts');

// Cả lớp thường chung một mạng Wi-Fi (cùng IP) nên giới hạn theo IP rộng; giới hạn chặt nằm ở từng người bên dưới
router.use(rateLimit({ windowMs: 60_000, max: 1200, name: 'rooms-ip' }));
const actorLimit = (name, max) => rateLimit({ windowMs: 60_000, max, name, keyFn: (req) => req.actor?.id });

const millisOf = (v) => (v?.toMillis ? v.toMillis() : v instanceof Date ? v.getTime() : null);
const iso = (v) => {
    const ms = millisOf(v);
    return ms == null ? null : new Date(ms).toISOString();
};

class RoomError extends Error {
    constructor(status, message, code) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function fail(res, status, message, code) {
    return res.status(status).json({ status: 'error', message, ...(code ? { code } : {}) });
}

const handle = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (err) {
        if (err instanceof RoomError) return fail(res, err.status, err.message, err.code);
        throw err;
    }
};

// Thông tin phòng gửi cho người tham gia
function toPublicRoom(code, r, now = Date.now()) {
    return {
        code,
        title: r.title,
        mode: r.mode || 'standard',
        status: effectiveStatus(r, now),
        questionCount: r.questionCount,
        timeLimitMinutes: r.timeLimitMinutes ?? null,
        participantCount: r.participantCount ?? 0,
        maxParticipants: r.maxParticipants,
        startedAt: iso(r.startedAt),
        endedAt: iso(r.endedAt),
        expiresAt: iso(r.expiresAt)
    };
}

// Chủ phòng thấy thêm quiz nào, version nào
const toHostRoom = (code, r, now) => ({ ...toPublicRoom(code, r, now), quizId: r.quizId, version: r.quizVersion, createdAt: iso(r.createdAt) });

// Đẩy tin phòng đổi trạng thái/số người cho mọi người đang nối WebSocket (lỗi đẩy tin không ảnh hưởng thao tác chính)
const publishRoom = (code, r) =>
    safePublish(() => {
        const now = Date.now();
        hub.publishRoom(code, toPublicRoom(code, r, now), toHostRoom(code, r, now));
    });

async function loadRoom(rawCode) {
    const code = normalizeCode(rawCode);
    if (!code) throw new RoomError(404, 'Không tìm thấy phòng. Kiểm tra lại mã phòng.');
    const snap = await rooms().doc(code).get();
    if (!snap.exists) throw new RoomError(404, 'Không tìm thấy phòng. Kiểm tra lại mã phòng.');
    return { code, ref: snap.ref, room: snap.data() };
}

// Chủ phòng là người dùng tạo ra phòng. Người khác nhận 404 (không tiết lộ phòng có tồn tại)
async function loadHostRoom(req) {
    const loaded = await loadRoom(req.params.code);
    if (req.actor.type !== 'user' || loaded.room.hostId !== req.actor.id) {
        throw new RoomError(404, 'Không tìm thấy phòng. Kiểm tra lại mã phòng.');
    }
    return loaded;
}

const createSchema = z
    .object({
        quizId: z.string().min(1).max(100),
        maxParticipants: z.number().int().min(1).max(MAX_PARTICIPANTS_LIMIT).optional(),
        mode: z.enum(Object.keys(ROOM_MODES)).optional()
    })
    .strict();

const joinSchema = z.object({ code: z.string().min(1).max(20) }).strict();

// ---------------------------------------------------------------------------
// Tạo phòng từ quiz đã publish (version mới nhất tại thời điểm tạo, chốt luôn cho cả phòng)
// ---------------------------------------------------------------------------
router.post(
    '/',
    userOnly,
    actorLimit('rooms-create', 10),
    handle(async (req, res) => {
        const parsed = createSchema.safeParse(req.body);
        if (!parsed.success) return fail(res, 400, 'Dữ liệu không hợp lệ');

        const quizSnap = await getDb().collection('quizzes').doc(parsed.data.quizId).get();
        if (!quizSnap.exists || quizSnap.data().deletedAt || quizSnap.data().ownerId !== req.actor.id) {
            return fail(res, 404, 'Không tìm thấy quiz');
        }
        const versionNumber = quizSnap.data().currentVersion;
        if (!versionNumber) return fail(res, 409, 'Quiz chưa publish nên chưa mở phòng được', 'not-published');

        const verSnap = await getDb().collection('quizVersions').doc(`${quizSnap.id}_${versionNumber}`).get();
        if (!verSnap.exists) return fail(res, 404, 'Không tìm thấy version của quiz');
        const version = verSnap.data();
        // Chế độ nhanh (khởi động, exit ticket) ghi đè số câu và thời gian; standard giữ cài đặt của quiz
        const cfg = roomModeConfig(parsed.data.mode, version.questions.length, version.settings?.timeLimitMinutes ?? null);

        // Giới hạn số phòng đang mở của một người để không tạo hàng loạt
        const mine = await rooms().where('hostId', '==', req.actor.id).limit(100).get();
        const now = Date.now();
        const active = mine.docs.filter((d) => effectiveStatus(d.data(), now) !== ROOM_STATUS.ENDED).length;
        if (active >= MAX_ACTIVE_ROOMS_PER_HOST) {
            return fail(res, 409, `Bạn đang có ${active} phòng chưa kết thúc. Hãy kết thúc bớt phòng cũ trước.`, 'too-many-rooms');
        }

        const data = {
            hostId: req.actor.id,
            quizId: quizSnap.id,
            quizVersion: versionNumber,
            title: version.title,
            mode: cfg.mode,
            questionLimit: cfg.questionLimit,
            questionCount: cfg.questionLimit ?? version.questions.length,
            timeLimitMinutes: cfg.timeLimitMinutes,
            maxParticipants: parsed.data.maxParticipants ?? DEFAULT_MAX_PARTICIPANTS,
            participantCount: 0,
            status: ROOM_STATUS.WAITING,
            startedAt: null,
            endedAt: null,
            expiresAt: new Date(now + ROOM_TTL_MS),
            createdAt: FieldValue.serverTimestamp()
        };

        // Mã là id của document: create() báo lỗi nếu mã đã có người dùng, khi đó thử mã khác
        for (let i = 0; i < 6; i++) {
            const code = generateCode();
            try {
                await rooms().doc(code).create(data);
                const snap = await rooms().doc(code).get();
                return res.status(201).json({ status: 'success', room: toHostRoom(code, snap.data(), Date.now()) });
            } catch (err) {
                if (err.code === 6 || /ALREADY_EXISTS/.test(err.message || '')) continue;
                throw err;
            }
        }
        return fail(res, 503, 'Chưa tạo được mã phòng, vui lòng thử lại', 'busy');
    })
);

// ---------------------------------------------------------------------------
// Các phòng của tôi (chủ phòng), mới nhất trước
// ---------------------------------------------------------------------------
router.get(
    '/mine',
    userOnly,
    actorLimit('rooms-mine', 30),
    handle(async (req, res) => {
        const snap = await rooms().where('hostId', '==', req.actor.id).limit(100).get();
        const now = Date.now();
        const list = snap.docs
            .map((d) => ({ code: d.id, data: d.data() }))
            .sort((a, b) => (millisOf(b.data.createdAt) ?? 0) - (millisOf(a.data.createdAt) ?? 0))
            .slice(0, 20)
            .map((x) => toHostRoom(x.code, x.data, now));
        res.status(200).json({ status: 'success', rooms: list });
    })
);

// ---------------------------------------------------------------------------
// Vào phòng bằng mã. Người dùng dùng tài khoản, khách dùng phiên khách (tên hiển thị đã có trong phiên).
// Vào lại thì giữ chỗ cũ. Kiểm tra đủ người và đếm trong transaction nên không vượt giới hạn dù nhiều người vào cùng lúc.
// ---------------------------------------------------------------------------
router.post(
    '/join',
    anyActor,
    actorLimit('rooms-join', 20),
    handle(async (req, res) => {
        const parsed = joinSchema.safeParse(req.body);
        if (!parsed.success) return fail(res, 400, 'Dữ liệu không hợp lệ');
        const code = normalizeCode(parsed.data.code);
        if (!code) return fail(res, 404, 'Không tìm thấy phòng. Kiểm tra lại mã phòng.');

        const displayName = req.actor.type === 'guest' ? req.actor.displayName : req.profile?.displayName || 'Người dùng';
        const roomRef = rooms().doc(code);
        const pRef = roomRef.collection('participants').doc(participantKey(req.actor));

        const rejoined = await getDb().runTransaction(async (tx) => {
            const [rSnap, pSnap] = await Promise.all([tx.get(roomRef), tx.get(pRef)]);
            if (!rSnap.exists) throw new RoomError(404, 'Không tìm thấy phòng. Kiểm tra lại mã phòng.');
            const r = rSnap.data();
            if (effectiveStatus(r, Date.now()) === ROOM_STATUS.ENDED) throw new RoomError(410, 'Phòng này đã kết thúc', 'room-ended');
            if (pSnap.exists) return true;
            if ((r.participantCount ?? 0) >= r.maxParticipants) throw new RoomError(409, 'Phòng đã đủ người', 'room-full');

            tx.set(pRef, { type: req.actor.type, id: req.actor.id, displayName, joinedAt: new Date(), attemptId: null, ...PROGRESS_WAITING });
            tx.update(roomRef, { participantCount: FieldValue.increment(1) });
            return false;
        });

        const fresh = await roomRef.get();
        if (!rejoined) {
            // Chủ phòng thấy người mới vào ngay, không cần hỏi lại server
            safePublish(() =>
                hub.publishParticipant(
                    code,
                    participantView(participantKey(req.actor), { type: req.actor.type, displayName, joinedAt: new Date(), ...PROGRESS_WAITING })
                )
            );
            publishRoom(code, fresh.data());
        }
        res.status(rejoined ? 200 : 201).json({
            status: 'success',
            rejoined,
            room: toPublicRoom(code, fresh.data()),
            me: { displayName }
        });
    })
);

// ---------------------------------------------------------------------------
// Xem trạng thái phòng (màn chờ hỏi định kỳ).
//  - Chủ phòng: thêm danh sách người tham gia và tiến độ làm bài.
//  - Người tham gia: thông tin phòng. Người chưa vào phòng nhận 404.
// ---------------------------------------------------------------------------
router.get(
    '/:code',
    anyActor,
    actorLimit('rooms-read', 90),
    handle(async (req, res) => {
        const { code, ref, room } = await loadRoom(req.params.code);
        const now = Date.now();

        if (req.actor.type === 'user' && room.hostId === req.actor.id) {
            // Tiến độ từng người đã lưu sẵn trên bản ghi tham gia (cập nhật khi bắt đầu/nộp bài), nên chỉ tốn 1 lượt đọc mỗi người
            const pSnap = await ref.collection('participants').limit(MAX_PARTICIPANTS_LIMIT).get();
            const participants = pSnap.docs
                .map((d) => participantView(d.id, d.data()))
                .sort((x, y) => (x.joinedAt || '').localeCompare(y.joinedAt || ''));

            return res.status(200).json({
                status: 'success',
                serverNow: new Date(now).toISOString(),
                role: 'host',
                room: toHostRoom(code, room, now),
                participants,
                counts: countParticipants(participants)
            });
        }

        const pSnap = await ref.collection('participants').doc(participantKey(req.actor)).get();
        if (!pSnap.exists) return fail(res, 404, 'Không tìm thấy phòng. Kiểm tra lại mã phòng.');
        res.status(200).json({
            status: 'success',
            serverNow: new Date(now).toISOString(),
            role: 'participant',
            room: toPublicRoom(code, room, now),
            me: { displayName: pSnap.data().displayName, attemptId: pSnap.data().attemptId ?? null }
        });
    })
);

// ---------------------------------------------------------------------------
// Chuyển trạng thái phòng (chủ phòng). Làm trong transaction nên bấm hai lần hoặc hai thiết bị cùng bấm vẫn chỉ chuyển một lần.
// ---------------------------------------------------------------------------
async function transition(ref, to) {
    return getDb().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const r = snap.data();
        const current = effectiveStatus(r, Date.now());
        if (current === to) return { changed: false, room: r };
        if (!canTransition(current, to)) {
            const msg = current === ROOM_STATUS.ENDED ? 'Phòng đã kết thúc' : 'Phòng đang chạy rồi';
            throw new RoomError(409, msg, 'bad-transition');
        }
        const patch = to === ROOM_STATUS.RUNNING ? { status: to, startedAt: new Date() } : { status: to, endedAt: new Date() };
        tx.update(ref, patch);
        return { changed: true, room: { ...r, ...patch } };
    });
}

router.post(
    '/:code/start',
    userOnly,
    actorLimit('rooms-host', 30),
    handle(async (req, res) => {
        const { code, ref } = await loadHostRoom(req);
        const { room } = await transition(ref, ROOM_STATUS.RUNNING);
        publishRoom(code, room);
        res.status(200).json({ status: 'success', room: toHostRoom(code, room, Date.now()) });
    })
);

// Kết thúc phòng (hoặc hủy phòng chưa bắt đầu). Các lượt làm đang dở trong phòng được nộp tự động theo bản đã lưu.
router.post(
    '/:code/end',
    userOnly,
    actorLimit('rooms-host', 30),
    handle(async (req, res) => {
        const { code, ref } = await loadHostRoom(req);
        const { room } = await transition(ref, ROOM_STATUS.ENDED);
        publishRoom(code, room);

        // Chốt các lượt còn dở. Lỗi một lượt không chặn các lượt khác (lượt đó vẫn bị chốt khi người làm mở lại)
        const open = await attempts().where('roomId', '==', code).limit(1000).get();
        const pending = open.docs.filter((d) => d.data().status === 'in_progress');
        let settled = 0;
        for (let i = 0; i < pending.length; i += 10) {
            const results = await Promise.allSettled(pending.slice(i, i + 10).map((d) => finalizeAttempt(d.id, { reason: 'room-ended' })));
            settled += results.filter((r) => r.status === 'fulfilled').length;
        }

        res.status(200).json({ status: 'success', room: toHostRoom(code, room, Date.now()), settled });
    })
);

export default router;

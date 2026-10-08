// Chức năng: luật thuần cho phòng làm bài (Phase 4) - mã phòng, chuyển trạng thái WAITING -> RUNNING -> ENDED, hết hạn phòng. Không gọi mạng/DB nên dễ test.
import crypto from 'node:crypto';

export const ROOM_STATUS = { WAITING: 'WAITING', RUNNING: 'RUNNING', ENDED: 'ENDED' };

// Bỏ các ký tự dễ nhầm khi đọc/gõ trên điện thoại: I, L, O, 0, 1
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 6;

export const ROOM_TTL_MS = 12 * 60 * 60 * 1000; // phòng tự hết hạn sau 12 giờ (bằng phiên khách)
export const DEFAULT_MAX_PARTICIPANTS = 50;
export const MAX_PARTICIPANTS_LIMIT = 200;
export const MAX_ACTIVE_ROOMS_PER_HOST = 5;

export function generateCode(randomInt = crypto.randomInt) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(0, CODE_ALPHABET.length)];
    return code;
}

// Chuẩn hóa mã người dùng gõ vào: bỏ khoảng trắng/dấu gạch, viết hoa. Trả null nếu sai dạng (không cần hỏi DB).
export function normalizeCode(input) {
    if (typeof input !== 'string') return null;
    const code = input.replace(/[\s-]/g, '').toUpperCase();
    if (code.length !== CODE_LENGTH) return null;
    return [...code].every((c) => CODE_ALPHABET.includes(c)) ? code : null;
}

const NEXT = {
    WAITING: ['RUNNING', 'ENDED'], // WAITING -> ENDED = hủy phòng chưa bắt đầu
    RUNNING: ['ENDED'],
    ENDED: []
};

export function canTransition(from, to) {
    return (NEXT[from] || []).includes(to);
}

// expiresAt có thể là Date, Firestore Timestamp, hoặc số ms
export function toMs(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.getTime();
    return v.toMillis ? v.toMillis() : null;
}

export function isRoomExpired(room, nowMs) {
    const exp = toMs(room?.expiresAt);
    return exp != null && nowMs > exp;
}

// Phòng chưa kết thúc nhưng đã quá hạn thì coi như đã kết thúc
export function effectiveStatus(room, nowMs) {
    if (!room) return ROOM_STATUS.ENDED;
    if (room.status !== ROOM_STATUS.ENDED && isRoomExpired(room, nowMs)) return ROOM_STATUS.ENDED;
    return room.status;
}

export const isRoomEnded = (room, nowMs) => effectiveStatus(room, nowMs) === ROOM_STATUS.ENDED;

// Khóa người tham gia trong phòng: rooms/{code}/participants/{key}
export const participantKey = (actor) => `${actor.type}_${actor.id}`;

// ---------------------------------------------------------------------------
// Chế độ nhanh: phòng khởi động (đầu giờ) và exit ticket (cuối giờ).
// Dùng chung quiz và Room Engine; chỉ khác số câu và thời gian. Mỗi người nhận một tập câu khác nhau (chọn theo seed của lượt làm).
// ---------------------------------------------------------------------------
export const ROOM_MODES = {
    standard: { label: 'Bình thường', questionLimit: null, timeLimitMinutes: null },
    warmup: { label: 'Khởi động', questionLimit: 5, timeLimitMinutes: 5 },
    exit: { label: 'Exit ticket', questionLimit: 3, timeLimitMinutes: 3 }
};

export const isRoomMode = (mode) => Object.hasOwn(ROOM_MODES, mode);

// Cấu hình thực tế của phòng. standard giữ nguyên cài đặt của quiz; chế độ nhanh ghi đè số câu và thời gian.
export function roomModeConfig(mode, totalQuestions, quizTimeLimitMinutes = null) {
    const key = isRoomMode(mode) ? mode : 'standard';
    const preset = ROOM_MODES[key];
    return {
        mode: key,
        questionLimit: preset.questionLimit == null ? null : Math.min(preset.questionLimit, totalQuestions),
        timeLimitMinutes: preset.timeLimitMinutes ?? quizTimeLimitMinutes ?? null
    };
}

// ---------------------------------------------------------------------------
// Tiến độ người tham gia, lưu sẵn ngay trên rooms/{code}/participants/{key} để chủ phòng không phải đọc từng lượt làm bài.
// ---------------------------------------------------------------------------
export const PROGRESS_WAITING = { status: 'waiting', correct: null, gradable: null, score10: null, submitReason: null };
export const PROGRESS_IN_PROGRESS = { status: 'in_progress', correct: null, gradable: null, score10: null, submitReason: null };

export function progressOfSubmitted(result, submitReason) {
    return {
        status: 'submitted',
        correct: result?.correct ?? null,
        gradable: result?.gradable ?? null,
        score10: result?.score10 ?? null,
        submitReason: submitReason ?? null
    };
}

const isoOf = (v) => {
    const ms = toMs(v);
    return ms == null ? null : new Date(ms).toISOString();
};

// Dạng người tham gia gửi cho chủ phòng. Bản ghi cũ chưa có tiến độ thì coi như đang chờ.
export function participantView(key, p) {
    return {
        key,
        displayName: p.displayName,
        type: p.type,
        joinedAt: isoOf(p.joinedAt),
        status: p.status || 'waiting',
        correct: p.correct ?? null,
        gradable: p.gradable ?? null,
        score10: p.score10 ?? null,
        submitReason: p.submitReason ?? null
    };
}

export function countParticipants(list) {
    const count = (s) => list.filter((p) => p.status === s).length;
    return { joined: list.length, inProgress: count('in_progress'), submitted: count('submitted') };
}

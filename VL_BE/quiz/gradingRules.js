// Chức năng: luật thuần cho làm bài (Phase 4) - seed và xáo trộn do server quyết định, dựng đề gửi cho người làm (KHÔNG có đáp án), kiểm tra dạng câu trả lời, chấm điểm, tính hạn nộp. Không gọi mạng/DB nên dễ test.
import crypto from 'node:crypto';
import { normalizeText } from '../worker/text.js';

export const GRACE_MS = 15_000; // dung sai mạng: nộp trễ tối đa 15 giây sau hạn vẫn được nhận
export const MAX_EVENTS = 200; // mỗi lượt làm ghi tối đa 200 sự kiện chống gian lận
export const EVENT_TYPES = ['tab_hidden', 'tab_visible', 'window_blur', 'window_focus', 'copy', 'paste'];
export const MAX_FILL_CHARS = 200;
export const MAX_SHORT_CHARS = 300;

// ---------------------------------------------------------------------------
// Seed và xáo trộn (server quyết định, lưu seed để dựng lại đúng thứ tự khi tải lại trang)
// ---------------------------------------------------------------------------
export function newSeed() {
    return crypto.randomInt(0, 2 ** 32);
}

// Từ một seed gốc sinh ra seed riêng cho từng việc (thứ tự câu hỏi, thứ tự đáp án của từng câu)
export function deriveSeed(seed, label) {
    return crypto.createHash('sha256').update(`${seed}:${label}`).digest().readUInt32BE(0);
}

// Bộ sinh số giả ngẫu nhiên mulberry32: cùng seed thì cùng dãy số
function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// Fisher-Yates theo seed. Không sửa mảng gốc.
export function seededShuffle(list, seed) {
    const rand = mulberry32(seed);
    const out = [...list];
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

// Sắp xếp đề theo cài đặt + seed. Mỗi đáp án mang "index" gốc để người làm gửi lại index gốc (index gốc không tiết lộ đáp án đúng).
// Đúng/sai luôn giữ nguyên thứ tự Đúng, Sai.
export function arrange(questions, settings, seed) {
    const base = settings?.shuffleQuestions ? seededShuffle(questions, deriveSeed(seed, 'questions')) : questions;
    return base.map((q) => {
        let options = (q.options || []).map((text, index) => ({ index, text }));
        if (settings?.shuffleOptions && (q.type === 'single' || q.type === 'multi')) {
            options = seededShuffle(options, deriveSeed(seed, `options:${q.id}`));
        }
        return { q, options };
    });
}

// Đề gửi xuống người làm: chỉ có id, loại, đề bài, đáp án. KHÔNG có đáp án đúng, giải thích hay nguồn.
export function buildAttemptView(questions, settings, seed) {
    return arrange(questions, settings, seed).map(({ q, options }) => ({
        id: q.id,
        type: q.type,
        stem: q.stem,
        options
    }));
}

// ---------------------------------------------------------------------------
// Kiểm tra dạng câu trả lời người làm gửi lên
// Dạng: single = số (index gốc) · multi = mảng số · truefalse = true (Đúng) / false (Sai) · fill, short = chuỗi · null = xóa câu trả lời
// ---------------------------------------------------------------------------
export function cleanAnswer(q, value) {
    const ok = (v) => ({ ok: true, value: v });
    const bad = { ok: false };
    if (value === null) return ok(null);

    const n = q.options?.length ?? 0;
    switch (q.type) {
        case 'single':
            return Number.isInteger(value) && value >= 0 && value < n ? ok(value) : bad;
        case 'multi': {
            if (!Array.isArray(value) || value.length > n) return bad;
            if (!value.every((i) => Number.isInteger(i) && i >= 0 && i < n)) return bad;
            const unique = [...new Set(value)].sort((a, b) => a - b);
            return ok(unique.length ? unique : null);
        }
        case 'truefalse':
            return typeof value === 'boolean' ? ok(value) : bad;
        case 'fill':
        case 'short': {
            if (typeof value !== 'string') return bad;
            const max = q.type === 'fill' ? MAX_FILL_CHARS : MAX_SHORT_CHARS;
            const text = normalizeText(value);
            if (text.length > max) return bad;
            return ok(text || null);
        }
        default:
            return bad;
    }
}

// Làm sạch cả bộ câu trả lời { [questionId]: value }. Trả { answers (đã sạch), rejected (id bị loại) }.
export function cleanAnswers(questions, input) {
    const byId = new Map(questions.map((q) => [q.id, q]));
    const answers = {};
    const rejected = [];
    for (const [id, value] of Object.entries(input || {})) {
        const q = byId.get(id);
        const r = q ? cleanAnswer(q, value) : { ok: false };
        if (!r.ok) {
            rejected.push(id);
            continue;
        }
        answers[id] = r.value;
    }
    return { answers, rejected };
}

// Gộp phần mới gửi (patch) vào câu trả lời đã lưu. Giá trị null nghĩa là xóa câu trả lời.
export function mergeAnswers(saved, patch) {
    const out = { ...(saved || {}) };
    for (const [id, value] of Object.entries(patch || {})) {
        if (value === null) delete out[id];
        else out[id] = value;
    }
    return out;
}

// ---------------------------------------------------------------------------
// Chấm điểm
// ---------------------------------------------------------------------------

// Điền khuyết: không phân biệt hoa/thường và khoảng trắng thừa, bỏ dấu câu cuối, coi "0,5" = "0.5". Giữ nguyên dấu tiếng Việt.
export function normalizeFill(text) {
    return normalizeText(text)
        .toLowerCase()
        .replace(/(\d),(\d)/g, '$1.$2')
        .replace(/[.!?;:]+$/u, '')
        .replace(/\s+/g, ' ')
        .trim();
}

// Trạng thái một câu: correct | wrong | unanswered | pending (trả lời ngắn: chưa tự chấm được)
function gradeOne(q, key, given) {
    if (given === undefined || given === null) return 'unanswered';
    if (q.type === 'short' || !key) return 'pending';

    switch (q.type) {
        case 'single':
        case 'truefalse':
            return given === key.correct ? 'correct' : 'wrong';
        case 'multi': {
            if (!Array.isArray(given) || !Array.isArray(key.correct)) return 'wrong';
            const g = new Set(given);
            const c = new Set(key.correct);
            // Phải chọn đúng và đủ tất cả đáp án đúng (không có điểm từng phần ở V1)
            return g.size === c.size && [...c].every((i) => g.has(i)) ? 'correct' : 'wrong';
        }
        case 'fill': {
            const accepted = [key.correct, ...(key.alternatives || [])].map(normalizeFill);
            return accepted.includes(normalizeFill(given)) ? 'correct' : 'wrong';
        }
        default:
            return 'pending';
    }
}

// questions: danh sách câu của version; keys: { [questionId]: { correct, alternatives? } }; answers: câu trả lời đã làm sạch.
// Câu trả lời ngắn không tự chấm: không tính vào điểm, hiện đáp án mẫu sau khi nộp để người học tự đối chiếu.
export function gradeAttempt(questions, keys, answers) {
    const statuses = {};
    let correct = 0;
    let wrong = 0;
    let unanswered = 0;
    let pending = 0;
    let gradable = 0;

    for (const q of questions) {
        const status = gradeOne(q, keys?.[q.id], answers?.[q.id]);
        statuses[q.id] = status;
        const isGradable = q.type !== 'short';
        if (isGradable) gradable++;

        if (status === 'correct') correct++;
        else if (status === 'wrong') wrong++;
        else if (status === 'pending') pending++;
        else if (isGradable) unanswered++;
    }

    return {
        correct,
        wrong,
        unanswered,
        pending,
        gradable,
        total: questions.length,
        percent: gradable ? Math.round((correct / gradable) * 100) : null,
        score10: gradable ? Math.round((correct / gradable) * 1000) / 100 : null,
        statuses
    };
}

// Bản xem lại sau khi nộp: đúng thứ tự và thứ tự đáp án người làm đã thấy, kèm đáp án đúng và giải thích
export function buildReview({ questions, settings, seed, keys, answers, statuses }) {
    return arrange(questions, settings, seed).map(({ q, options }) => {
        const key = keys?.[q.id] || {};
        return {
            id: q.id,
            type: q.type,
            stem: q.stem,
            options,
            given: answers?.[q.id] ?? null,
            correct: key.correct ?? null,
            alternatives: key.alternatives || [],
            status: statuses?.[q.id] || 'unanswered',
            explanation: q.explanation || ''
        };
    });
}

// ---------------------------------------------------------------------------
// Giờ làm bài (mốc thời gian do server tính, không tin đồng hồ của client)
// ---------------------------------------------------------------------------
export function computeDeadline(startMs, timeLimitMinutes) {
    return timeLimitMinutes ? startMs + timeLimitMinutes * 60_000 : null;
}

// Quá hạn khi vượt mốc hết giờ cộng dung sai GRACE_MS
export function isPastDeadline(deadlineMs, nowMs) {
    return deadlineMs != null && nowMs > deadlineMs + GRACE_MS;
}

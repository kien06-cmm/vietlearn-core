// Chức năng: luật thuần cho làm bài (Phase 4) - seed và xáo trộn do server quyết định, dựng đề gửi cho người làm (KHÔNG có đáp án), kiểm tra dạng câu trả lời, chấm điểm, tính hạn nộp. Không gọi mạng/DB nên dễ test.
import crypto from 'node:crypto';
import { normalizeText } from '../worker/text.js';

export const GRACE_MS = 15_000; // dung sai mạng: nộp trễ tối đa 15 giây sau hạn vẫn được nhận
export const MAX_EVENTS = 200; // mỗi lượt làm ghi tối đa 200 sự kiện chống gian lận
export const EVENT_TYPES = ['tab_hidden', 'tab_visible', 'window_blur', 'window_focus', 'copy', 'paste'];
export const CONFIDENCE_LEVELS = ['sure', 'unsure', 'guess'];
export const MAX_CHANGES = 50;
export const MAX_SPENT_MS = 3_600_000; // thời gian tối đa ghi cho một câu: 1 giờ
export const CARELESS_MS = 3000; // sai mà trả lời dưới 3 giây thì gợi ý là ẩu
export const ERROR_TYPES = ['timeout', 'guess', 'careless', 'changed', 'misconception', 'knowledge'];
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
// Chế độ nhanh (khởi động, exit ticket): mỗi lượt làm chỉ gồm một phần câu hỏi của version.
// Tập câu chọn theo seed của lượt làm (mỗi người một tập khác nhau) và lưu lại id để chấm/xem lại đúng tập đó.
// ---------------------------------------------------------------------------

// Trả mảng id đã chọn, hoặc null nếu dùng đủ tất cả câu
export function pickQuestionIds(questions, count, seed) {
    if (!Number.isInteger(count) || count < 1 || count >= questions.length) return null;
    return seededShuffle(
        questions.map((q) => q.id),
        deriveSeed(seed, 'pick')
    ).slice(0, count);
}

// Giữ nguyên thứ tự gốc của version; thứ tự hiển thị do arrange() quyết định theo seed
export function questionsForAttempt(questions, ids) {
    if (!ids) return questions;
    const set = new Set(ids);
    return questions.filter((q) => set.has(q.id));
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
export function buildReview({ questions, settings, seed, keys, answers, statuses, confidence, changes, spent, errorTypes }) {
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
            topicId: q.topicId ?? null,
            confidence: confidence?.[q.id] ?? null,
            changes: changes?.[q.id] ?? 0,
            spentMs: spent?.[q.id] ?? null,
            errorType: errorTypes?.[q.id] ?? null,
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

// ---------------------------------------------------------------------------
// Mức tự tin + số lần đổi đáp án (Phase 5)
// ---------------------------------------------------------------------------

// Làm sạch { [questionId]: 'sure' | 'unsure' | 'guess' | null }
export function cleanConfidence(questions, input) {
    const ids = new Set(questions.map((q) => q.id));
    const confidence = {};
    const rejected = [];
    for (const [id, value] of Object.entries(input || {})) {
        if (!ids.has(id) || (value !== null && !CONFIDENCE_LEVELS.includes(value))) {
            rejected.push(id);
            continue;
        }
        confidence[id] = value;
    }
    return { confidence, rejected };
}

// Bỏ mức tự tin của câu không còn câu trả lời
export function pruneConfidence(confidence, answers) {
    const out = {};
    for (const [id, level] of Object.entries(confidence || {})) {
        if (answers?.[id] !== undefined && answers?.[id] !== null) out[id] = level;
    }
    return out;
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Đếm lần đổi đáp án: câu chọn đã có trả lời lưu sẵn và giá trị mới khác. Bỏ qua câu gõ chữ (fill, short) vì mỗi lần lưu nháp là thêm vài ký tự
export function countChanges(prev, saved, patch, questions = []) {
    const typed = new Set(questions.filter((q) => q.type === 'fill' || q.type === 'short').map((q) => q.id));
    const out = { ...(prev || {}) };
    for (const [id, value] of Object.entries(patch || {})) {
        const before = saved?.[id];
        if (typed.has(id) || value === null || before === undefined || before === null || sameValue(before, value)) continue;
        out[id] = Math.min((out[id] || 0) + 1, MAX_CHANGES);
    }
    return out;
}

// Thống kê đúng/sai theo mức tự tin. Chỉ tính câu đã chấm (đúng/sai)
export function summarizeConfidence(statuses, confidence) {
    const levels = Object.fromEntries(CONFIDENCE_LEVELS.map((l) => [l, { correct: 0, wrong: 0 }]));
    let rated = 0;
    for (const [id, level] of Object.entries(confidence || {})) {
        const status = statuses?.[id];
        if (!CONFIDENCE_LEVELS.includes(level) || (status !== 'correct' && status !== 'wrong')) continue;
        levels[level][status]++;
        rated++;
    }
    return { rated, levels, sureWrong: levels.sure.wrong, guessCorrect: levels.guess.correct };
}

// Thống kê theo chủ đề, chủ đề yếu nhất lên đầu. topicInfo: { [topicId]: { subject, chapter, name } }
export function summarizeTopics(questions, statuses, topicInfo) {
    const map = new Map();
    for (const q of questions) {
        const status = statuses?.[q.id];
        if (q.type === 'short') continue;
        const key = q.topicId || '';
        const t = map.get(key) || { topicId: key || null, correct: 0, wrong: 0, unanswered: 0, total: 0 };
        t.total++;
        if (status === 'correct') t.correct++;
        else if (status === 'wrong') t.wrong++;
        else t.unanswered++;
        map.set(key, t);
    }
    return [...map.values()]
        .map((t) => {
            const info = topicInfo?.[t.topicId] || {};
            return { ...t, name: info.name ?? null, chapter: info.chapter ?? null, subject: info.subject ?? null };
        })
        .sort((a, b) => a.correct / a.total - b.correct / b.total || b.total - a.total);
}

// ---------------------------------------------------------------------------
// Thời gian từng câu + gợi ý kiểu sai (Phase 5)
// ---------------------------------------------------------------------------

// Làm sạch { [questionId]: ms } do client báo (cộng dồn)
export function cleanSpent(questions, input) {
    const ids = new Set(questions.map((q) => q.id));
    const spent = {};
    for (const [id, ms] of Object.entries(input || {})) {
        if (!ids.has(id) || !Number.isFinite(ms) || ms < 0) continue;
        spent[id] = Math.min(Math.round(ms), MAX_SPENT_MS);
    }
    return spent;
}

// Thời gian cộng dồn chỉ tăng, lấy giá trị lớn hơn (gửi trùng hay sai thứ tự vẫn đúng)
export function mergeSpent(saved, patch) {
    const out = { ...(saved || {}) };
    for (const [id, ms] of Object.entries(patch || {})) out[id] = Math.max(out[id] || 0, ms);
    return out;
}

// Gợi ý kiểu sai cho MỘT câu theo luật cố định. Thứ tự ưu tiên: hết giờ, đoán, ẩu, đổi đáp án, hiểu nhầm, thiếu kiến thức.
// Trả null nếu không phải lỗi (đúng, tự đối chiếu) hoặc bỏ trống mà không phải do hết giờ.
export function classifyError({ status, type, confidence, changes = 0, spentMs = null, submitReason = null }) {
    if (type === 'short' || status === 'correct' || status === 'pending') return null;
    if (status === 'unanswered') return submitReason === 'timeout' || submitReason === 'room-ended' ? 'timeout' : null;
    if (status !== 'wrong') return null;
    if (confidence === 'guess') return 'guess';
    if (spentMs != null && spentMs < CARELESS_MS) return 'careless';
    if (changes > 0) return 'changed';
    if (confidence === 'sure') return 'misconception';
    return 'knowledge';
}

// Phân loại cả lượt làm: { byQuestion: { [id]: loại }, summary: { [loại]: số câu } }
export function classifyErrors({ questions, statuses, confidence, changes, spent, submitReason }) {
    const byQuestion = {};
    const summary = Object.fromEntries(ERROR_TYPES.map((t) => [t, 0]));
    for (const q of questions) {
        const t = classifyError({
            status: statuses?.[q.id],
            type: q.type,
            confidence: confidence?.[q.id],
            changes: changes?.[q.id] || 0,
            spentMs: spent?.[q.id] ?? null,
            submitReason
        });
        if (!t) continue;
        byQuestion[q.id] = t;
        summary[t]++;
    }
    return { byQuestion, summary };
}

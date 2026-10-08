// Chức năng: luật thuần cho Quiz (Phase 4) - cài đặt mặc định, băm nội dung, dựng bản chụp (snapshot) khi publish. Không gọi mạng/DB nên dễ test.
import crypto from 'node:crypto';

export const MAX_QUESTIONS_PER_QUIZ = 100;
export const MAX_QUIZZES = 100;

export const DEFAULT_SETTINGS = {
    timeLimitMinutes: null,
    maxAttempts: null,
    shuffleQuestions: true,
    shuffleOptions: true
};

// Gộp cài đặt: mặc định < hiện có < phần sửa. Luôn trả đủ 4 khóa theo thứ tự cố định (để băm ổn định)
export function mergeSettings(current, patch) {
    const s = { ...DEFAULT_SETTINGS, ...(current || {}), ...(patch || {}) };
    return {
        timeLimitMinutes: s.timeLimitMinutes ?? null,
        maxAttempts: s.maxAttempts ?? null,
        shuffleQuestions: s.shuffleQuestions,
        shuffleOptions: s.shuffleOptions
    };
}

export function hashOf(value) {
    return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

export function dedupeIds(ids) {
    return [...new Set(ids)];
}

export function draftHash({ title, description, questionIds, settings }) {
    return hashOf({ title, description: description || '', questionIds, settings });
}

// Dựng lại dạng "thô" của câu hỏi để chạy lại luật kiểm tra parseQuestion
export function rawOf(q, key) {
    const raw = {
        type: q.type,
        chunkId: q.source?.chunkId ?? 'import',
        stem: q.stem,
        explanation: q.explanation || undefined,
        correct: key?.correct,
        ...(key?.alternatives ? { alternatives: key.alternatives } : {})
    };
    if (q.type === 'single' || q.type === 'multi') raw.options = q.options;
    return raw;
}

// items: [{ id, q, key }] theo đúng thứ tự trong quiz. Trả phần hiển thị (không đáp án) và phần đáp án tách riêng
export function buildSnapshot(items) {
    const questions = items.map(({ id, q }) => ({
        id,
        type: q.type,
        topicId: q.topicId,
        stem: q.stem,
        options: q.options || [],
        explanation: q.explanation || '',
        source: q.source || null
    }));
    const keys = {};
    for (const { id, key } of items) {
        keys[id] = {
            type: key.type,
            correct: key.correct,
            ...(key.alternatives?.length ? { alternatives: key.alternatives } : {})
        };
    }
    return { questions, keys };
}

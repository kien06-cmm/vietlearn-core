// Chức năng: sổ lỗi sai (Phase 5) - truy cập Firestore users/{uid}/mistakes/{questionId}. Ghi câu sai khi nộp bài, đếm câu cần ôn, đọc tên chủ đề.
// Để subcollection theo người dùng nên mọi truy vấn chỉ cần chỉ mục đơn (không cần chỉ mục kết hợp) và người này không đọc được dữ liệu người kia.
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from './firebase.js';
import { classifyErrors } from './quiz/gradingRules.js';
import { applyWrong, wrongPicks } from './quiz/learningRules.js';

export const mistakesCol = (uid) => getDb().collection('users').doc(uid).collection('mistakes');

// Số bản ghi khớp truy vấn (đếm ở phía Firestore, không tốn một lượt đọc cho mỗi bản ghi)
export async function countOf(query) {
    const snap = await query.count().get();
    return snap.data().count;
}

// Tên chủ đề cho các câu (hiện ở sổ lỗi sai). Tối đa 100 chủ đề một lần.
export async function loadTopicNames(topicIds) {
    const ids = [...new Set((topicIds || []).filter(Boolean))].slice(0, 100);
    if (!ids.length) return {};
    const snaps = await getDb().getAll(...ids.map((id) => getDb().collection('topics').doc(id)));
    const info = {};
    for (const s of snaps) if (s.exists) info[s.id] = { name: s.data().name, chapter: s.data().chapter, subject: s.data().subject };
    return info;
}

// Ghi các câu sai của một lượt làm vào sổ lỗi sai của người dùng (chỉ tài khoản, khách chưa có sổ).
// questions: các câu của lượt làm; keys: đáp án của version; attempt: lượt làm đã chấm (answers, confidence, changes, spent, result, submitReason).
// Câu trả lời ngắn không tự chấm nên không vào sổ. Trả về số câu đã ghi.
export async function recordMistakes({ uid, quizId, quizVersion, questions, keys, attempt, nowMs = Date.now() }) {
    const statuses = attempt.result?.statuses || {};
    const wrong = questions.filter((q) => q.type !== 'short' && statuses[q.id] === 'wrong');
    if (!wrong.length) return 0;

    const errors = classifyErrors({
        questions,
        statuses,
        confidence: attempt.confidence,
        changes: attempt.changes,
        spent: attempt.spent,
        submitReason: attempt.submitReason
    });

    const refs = wrong.map((q) => mistakesCol(uid).doc(q.id));
    const snaps = await getDb().getAll(...refs);
    const batch = getDb().batch();
    wrong.forEach((q, i) => {
        const key = keys?.[q.id] || {};
        const prev = snaps[i].exists ? snaps[i].data() : null;
        const data = applyWrong(
            prev,
            {
                questionId: q.id,
                quizId,
                quizVersion,
                topicId: q.topicId ?? null,
                type: q.type,
                stem: q.stem,
                options: q.options || [],
                correct: key.correct ?? null,
                alternatives: key.alternatives || [],
                explanation: q.explanation || '',
                errorType: errors.byQuestion[q.id] ?? null,
                confidence: attempt.confidence?.[q.id] ?? null,
                picks: wrongPicks(q.type, attempt.answers?.[q.id], key.correct)
            },
            nowMs
        );
        batch.set(refs[i], { ...data, ...(prev ? {} : { createdAt: FieldValue.serverTimestamp() }), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    });
    await batch.commit();
    return wrong.length;
}

// Chức năng: API ôn tập (Phase 5) - tóm tắt hôm nay cần ôn bao nhiêu câu, sổ lỗi sai, lấy câu đến hạn ôn (không có đáp án), chấm từng câu khi ôn và cập nhật lịch ôn 1 -> 3 -> 7 ngày.
// Dữ liệu: users/{uid}/mistakes/{questionId} (xem mistakes.js, quiz/learningRules.js). Chỉ tài khoản có sổ lỗi sai; khách chưa dùng được.
// Đáp án đúng chỉ trả về SAU KHI người học đã trả lời câu đó (POST /review/grade).
import { Router } from 'express';
import { z } from 'zod';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../firebase.js';
import { requireRole } from '../middleware/permissions.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { CONFIDENCE_LEVELS, cleanAnswers, cleanConfidence, gradeAttempt } from '../quiz/gradingRules.js';
import {
    MAX_MISTAKES_LIST,
    MAX_REVIEW_BATCH,
    applyReview,
    summarizeMistakes,
    toListItem,
    toReviewQuestion,
    wrongPicks
} from '../quiz/learningRules.js';
import { countOf, loadTopicNames, mistakesCol } from '../mistakes.js';
import { recordTopicOutcomes, statsCol } from '../mastery.js';
import { buildKnowledgeMap, outcomesByTopic, toMasteryItem } from '../quiz/masteryRules.js';

const router = Router();
const userOnly = requireRole(['user']);
const actorLimit = (name, max) => rateLimit({ windowMs: 60_000, max, name, keyFn: (req) => req.actor?.id });

const millisOf = (v) => (v?.toMillis ? v.toMillis() : v instanceof Date ? v.getTime() : null);
const iso = (v) => {
    const ms = millisOf(v);
    return ms == null ? null : new Date(ms).toISOString();
};

function fail(res, status, message, code) {
    return res.status(status).json({ status: 'error', message, ...(code ? { code } : {}) });
}

function intParam(value, min, max, fallback) {
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) ? Math.min(Math.max(n, min), max) : fallback;
}

// ---------------------------------------------------------------------------
// Tóm tắt nhẹ cho Trang chủ: chỉ đếm (không đọc từng câu), nên rẻ dù sổ lỗi sai có nhiều câu.
// ---------------------------------------------------------------------------
router.get(
    '/summary',
    userOnly,
    actorLimit('review-summary', 60),
    async (req, res) => {
        const col = mistakesCol(req.actor.id);
        const now = new Date();
        // nextReviewAt = null (câu đã nắm) không khớp truy vấn khoảng nên không bị đếm là đến hạn
        const [open, due, mastered, next] = await Promise.all([
            countOf(col.where('status', '==', 'open')),
            countOf(col.where('nextReviewAt', '<=', now)),
            countOf(col.where('status', '==', 'mastered')),
            col.where('nextReviewAt', '>', now).orderBy('nextReviewAt').limit(1).get()
        ]);
        res.status(200).json({
            status: 'success',
            serverNow: now.toISOString(),
            open,
            due,
            mastered,
            nextDueAt: next.empty ? null : iso(next.docs[0].data().nextReviewAt)
        });
    }
);

// ---------------------------------------------------------------------------
// Sổ lỗi sai: các câu đang ôn (mặc định) hoặc đã nắm (?status=mastered), kèm đáp án đúng, đáp án hay chọn nhầm, kiểu sai gợi ý.
// ---------------------------------------------------------------------------
router.get(
    '/mistakes',
    userOnly,
    actorLimit('review-mistakes', 30),
    async (req, res) => {
        const status = req.query.status === 'mastered' ? 'mastered' : 'open';
        const snap = await mistakesCol(req.actor.id).where('status', '==', status).limit(MAX_MISTAKES_LIST).get();
        const docs = snap.docs.map((d) => d.data());

        // Câu sắp đến hạn lên đầu; câu đã nắm thì mới ôn gần đây nhất lên đầu
        const key = status === 'open' ? (d) => millisOf(d.nextReviewAt) ?? 0 : (d) => -(millisOf(d.lastReviewedAt) ?? 0);
        docs.sort((a, b) => key(a) - key(b));

        const topicNames = await loadTopicNames(docs.map((d) => d.topicId));
        const summary = status === 'open' ? summarizeMistakes(docs) : null;
        if (summary) {
            summary.weakTopics = summary.weakTopics.map((t) => ({ ...t, name: topicNames[t.topicId]?.name ?? null }));
        }
        res.status(200).json({
            status: 'success',
            serverNow: new Date().toISOString(),
            mistakes: docs.map((d) => toListItem(d, topicNames)),
            summary
        });
    }
);

// ---------------------------------------------------------------------------
// Lấy câu để ôn. scope=due (mặc định): chỉ câu đã đến hạn, câu quá hạn lâu nhất trước.
// scope=open: ôn thêm cả câu chưa đến hạn, câu ở mốc thấp trước. Không có đáp án.
// ---------------------------------------------------------------------------
router.get(
    '/due',
    userOnly,
    actorLimit('review-due', 30),
    async (req, res) => {
        const limit = intParam(req.query.limit, 1, MAX_REVIEW_BATCH, 10);
        const col = mistakesCol(req.actor.id);
        let docs;
        if (req.query.scope === 'open') {
            const snap = await col.where('status', '==', 'open').limit(100).get();
            docs = snap.docs
                .map((d) => d.data())
                .sort((a, b) => (a.stage ?? 0) - (b.stage ?? 0) || (millisOf(a.nextReviewAt) ?? 0) - (millisOf(b.nextReviewAt) ?? 0))
                .slice(0, limit);
        } else {
            const snap = await col.where('nextReviewAt', '<=', new Date()).orderBy('nextReviewAt').limit(limit).get();
            docs = snap.docs.map((d) => d.data());
        }
        res.status(200).json({ status: 'success', serverNow: new Date().toISOString(), questions: docs.map(toReviewQuestion) });
    }
);

// ---------------------------------------------------------------------------
// Chấm câu vừa ôn và cập nhật lịch ôn. Giao diện gửi từng câu một để có phản hồi ngay, nhưng nhận tối đa vài câu một lần.
// Câu bỏ trống thì không đổi lịch. Trả về đáp án đúng + giải thích + lần ôn kế tiếp.
// ---------------------------------------------------------------------------
const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
const gradeSchema = z
    .object({
        answers: z
            .record(z.string().min(1).max(100), z.unknown())
            .refine((m) => Object.keys(m).length >= 1 && Object.keys(m).length <= MAX_REVIEW_BATCH && Object.keys(m).every((k) => idPattern.test(k)), 'Số câu hoặc mã câu không hợp lệ'),
        confidence: z.record(z.string().min(1).max(100), z.enum(CONFIDENCE_LEVELS).nullable()).optional()
    })
    .strict();

router.post(
    '/grade',
    userOnly,
    actorLimit('review-grade', 90),
    async (req, res) => {
        const parsed = gradeSchema.safeParse(req.body);
        if (!parsed.success) return fail(res, 400, 'Dữ liệu không hợp lệ');

        const col = mistakesCol(req.actor.id);
        const ids = Object.keys(parsed.data.answers);
        const snaps = await getDb().getAll(...ids.map((id) => col.doc(id)));
        const docs = new Map();
        for (const s of snaps) if (s.exists && s.data().status) docs.set(s.id, s.data());
        if (docs.size === 0) return fail(res, 404, 'Không tìm thấy câu trong sổ lỗi sai');

        // Dựng lại câu + đáp án từ bản chụp trong sổ để chấm bằng đúng luật của bài thường
        const questions = [...docs].map(([id, d]) => ({ id, type: d.type, topicId: d.topicId ?? null, options: d.options || [] }));
        const keys = Object.fromEntries([...docs].map(([id, d]) => [id, { correct: d.correct, alternatives: d.alternatives }]));
        const { answers, rejected } = cleanAnswers(questions, parsed.data.answers);
        const { confidence } = cleanConfidence(questions, parsed.data.confidence);
        const result = gradeAttempt(questions, keys, answers);

        const nowMs = Date.now();
        const batch = getDb().batch();
        const items = [];
        for (const q of questions) {
            const status = result.statuses[q.id];
            if (status !== 'correct' && status !== 'wrong') continue; // bỏ trống hoặc tự đối chiếu: không đổi lịch
            const doc = docs.get(q.id);
            const patch = applyReview(
                doc,
                { status, confidence: confidence[q.id] ?? null, picks: status === 'wrong' ? wrongPicks(doc.type, answers[q.id], doc.correct) : [] },
                nowMs
            );
            batch.update(col.doc(q.id), { ...patch, updatedAt: FieldValue.serverTimestamp() });
            items.push({
                id: q.id,
                status,
                given: answers[q.id] ?? null,
                correct: doc.correct ?? null,
                alternatives: doc.alternatives || [],
                explanation: doc.explanation || '',
                stage: patch.stage,
                mastered: patch.status === 'mastered',
                nextReviewAt: iso(patch.nextReviewAt)
            });
        }
        if (items.length) await batch.commit();

        // Mức thành thạo theo chủ đề: ôn tập cũng là bằng chứng. Lỗi ở đây không được làm hỏng việc chấm câu ôn đã lưu.
        try {
            await recordTopicOutcomes({ uid: req.actor.id, outcomes: outcomesByTopic(questions, result.statuses, confidence), nowMs });
        } catch (err) {
            console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', message: `mastery: ${err.message}` }));
        }

        res.status(200).json({
            status: 'success',
            items,
            rejected,
            summary: {
                answered: items.length,
                correct: items.filter((i) => i.status === 'correct').length,
                wrong: items.filter((i) => i.status === 'wrong').length,
                mastered: items.filter((i) => i.mastered).length
            }
        });
    }
);

// ---------------------------------------------------------------------------
// Bản đồ kiến thức: mức thành thạo từng chủ đề (Môn -> Chương -> Chủ đề), tính trên 30 câu gần nhất của mỗi chủ đề.
// weakest: các chủ đề yếu nhất (cần ít nhất 5 câu mới xếp loại) để nút "Luyện phần yếu" dùng.
// ---------------------------------------------------------------------------
router.get(
    '/mastery',
    userOnly,
    actorLimit('review-mastery', 30),
    async (req, res) => {
        // Chủ đề học gần đây nhất trước; loadTopicNames đọc tối đa 100 chủ đề một lần nên lấy đúng 100
        const snap = await statsCol(req.actor.id).orderBy('lastAt', 'desc').limit(100).get();
        const docs = snap.docs.map((d) => ({ topicId: d.id, ...d.data() }));
        const info = await loadTopicNames(docs.map((d) => d.topicId));
        const items = docs.map((d) => toMasteryItem(d, info[d.topicId]));
        res.status(200).json({ status: 'success', serverNow: new Date().toISOString(), ...buildKnowledgeMap(items) });
    }
);

export default router;

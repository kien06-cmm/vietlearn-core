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
    applyWrong,
    summarizeMistakes,
    toListItem,
    toReviewQuestion,
    wrongPicks
} from '../quiz/learningRules.js';
import { countOf, loadTopicNames, mistakesCol } from '../mistakes.js';
import { recordTopicOutcomes, statsCol } from '../mastery.js';
import { buildKnowledgeMap, outcomesByTopic, toMasteryItem } from '../quiz/masteryRules.js';
import { pickPractice, toPracticeQuestion } from '../quiz/practiceRules.js';
import { creditLimits, getPlan } from '../config/plans.js';
import { QuotaError, currentPeriod, reserveCredits } from '../credits.js';
import { MAX_PRACTICE_COUNT } from '../ai/weaknessRules.js';
import { wakeWorker } from '../worker/index.js';

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
        // Câu chưa có trong sổ nhưng là câu đã duyệt trong ngân hàng của chính người dùng (luyện phần yếu): chấm từ ngân hàng
        const bank = await loadBank(req.actor.id, ids.filter((id) => !docs.has(id)));
        if (docs.size + bank.size === 0) return fail(res, 404, 'Không tìm thấy câu để chấm');

        // Dựng lại câu + đáp án từ bản chụp trong sổ (hoặc từ ngân hàng) để chấm bằng đúng luật của bài thường
        const questions = [
            ...[...docs].map(([id, d]) => ({ id, type: d.type, topicId: d.topicId ?? null, options: d.options || [] })),
            ...[...bank].map(([id, b]) => ({ id, type: b.q.type, topicId: b.q.topicId ?? null, options: b.q.options || [] }))
        ];
        const keys = Object.fromEntries([
            ...[...docs].map(([id, d]) => [id, { correct: d.correct, alternatives: d.alternatives }]),
            ...[...bank].map(([id, b]) => [id, { correct: b.key.correct, alternatives: b.key.alternatives }])
        ]);
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
            if (!doc) {
                // Câu từ ngân hàng: đúng thì không cần ghi sổ; sai thì vào sổ lỗi sai để ôn theo lịch 1 -> 3 -> 7 ngày
                const { q: bq, key } = bank.get(q.id);
                let nextReviewAt = null;
                if (status === 'wrong') {
                    const data = applyWrong(
                        null,
                        {
                            questionId: q.id,
                            quizId: null,
                            quizVersion: null,
                            topicId: bq.topicId ?? null,
                            type: bq.type,
                            stem: bq.stem,
                            options: bq.options || [],
                            correct: key.correct ?? null,
                            alternatives: key.alternatives || [],
                            explanation: bq.explanation || '',
                            confidence: confidence[q.id] ?? null,
                            picks: wrongPicks(bq.type, answers[q.id], key.correct)
                        },
                        nowMs
                    );
                    batch.set(col.doc(q.id), { ...data, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
                    nextReviewAt = iso(data.nextReviewAt);
                }
                items.push({
                    id: q.id,
                    status,
                    given: answers[q.id] ?? null,
                    correct: key.correct ?? null,
                    alternatives: key.alternatives || [],
                    explanation: bq.explanation || '',
                    stage: status === 'wrong' ? 0 : null,
                    mastered: false,
                    nextReviewAt,
                    fresh: true
                });
                continue;
            }
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

// ---------------------------------------------------------------------------
// Luyện phần yếu: bộ câu luyện cho MỘT chủ đề (GET /review/practice?topicId=...&limit=10), không có đáp án.
// Gồm câu từng sai ở chủ đề đó (đang ôn trước, sai nhiều trước) và câu đã duyệt trong ngân hàng của chính người dùng (miễn phí, không gọi AI).
// Người không sở hữu chủ đề (vd: học sinh làm quiz của giáo viên) chỉ có câu từng sai. Chấm bằng POST /review/grade như câu ôn.
// ---------------------------------------------------------------------------
router.get(
    '/practice',
    userOnly,
    actorLimit('review-practice', 30),
    async (req, res) => {
        const topicId = String(req.query.topicId || '');
        if (!idPattern.test(topicId)) return fail(res, 400, 'Chủ đề không hợp lệ');
        const limit = intParam(req.query.limit, 1, MAX_REVIEW_BATCH, 10);
        const uid = req.actor.id;

        const [mSnap, bSnap, pSnap] = await Promise.all([
            mistakesCol(uid).where('topicId', '==', topicId).limit(100).get(),
            getDb()
                .collection('questions')
                .where('ownerId', '==', uid)
                .where('topicId', '==', topicId)
                .where('reviewStatus', '==', 'approved')
                .limit(100)
                .get(),
            // Câu AI tạo riêng để luyện phần yếu (chưa duyệt): vẫn cho luyện, giao diện có nhãn "chưa duyệt"
            getDb()
                .collection('questions')
                .where('ownerId', '==', uid)
                .where('topicId', '==', topicId)
                .where('origin', '==', 'ai-practice')
                .limit(50)
                .get()
        ]);
        const mistakes = mSnap.docs.map((d) => d.data());
        const bankById = new Map(); // câu đã duyệt đồng thời là câu ai-practice thì chỉ lấy một lần
        for (const d of [...bSnap.docs, ...pSnap.docs]) bankById.set(d.id, { id: d.id, ...d.data() });
        const bank = [...bankById.values()].filter((q) => q.type !== 'short'); // câu trả lời ngắn không tự chấm được

        const picked = pickPractice(mistakes, bank, limit);
        res.status(200).json({
            status: 'success',
            serverNow: new Date().toISOString(),
            questions: picked.map((p) => (p.kind === 'mistake' ? toReviewQuestion(p.doc) : toPracticeQuestion(p.q)))
        });
    }
);

// ---------------------------------------------------------------------------
// Tạo câu luyện bằng AI từ câu từng sai (POST /review/practice/generate { topicId, count }).
// Tốn AI credits (1 credit = 1 câu, giữ chỗ trước, hoàn phần không dùng). Worker tra ngược đoạn tài liệu nguồn của các câu sai rồi nhờ AI soạn câu MỚI (worker/generatePractice.js).
// Trả jobId để giao diện hỏi tiến độ bằng GET /questions/jobs/:jobId; xong thì GET /review/practice sẽ có thêm các câu mới.
// ---------------------------------------------------------------------------
const practiceGenerateSchema = z
    .object({
        topicId: z.string().regex(idPattern),
        count: z.number().int().min(1).max(MAX_PRACTICE_COUNT).default(5)
    })
    .strict();

const MAX_ACTIVE_PRACTICE_JOBS = 1; // mỗi người chỉ một job tạo câu luyện chạy cùng lúc

router.post(
    '/practice/generate',
    userOnly,
    actorLimit('review-practice-generate', 5),
    async (req, res) => {
        const parsed = practiceGenerateSchema.safeParse(req.body);
        if (!parsed.success) return fail(res, 400, 'Dữ liệu không hợp lệ');

        const uid = req.actor.id;
        const { topicId } = parsed.data;
        const plan = getPlan(req.profile.plan);
        const count = Math.min(parsed.data.count, plan.maxQuestionsPerJob);
        const db = getDb();

        const topicSnap = await db.collection('topics').doc(topicId).get();
        if (!topicSnap.exists) return fail(res, 404, 'Không tìm thấy chủ đề');

        // Phải có câu sai ở chủ đề này làm căn cứ (không có thì không tốn credits cho một job chắc chắn thất bại)
        const mistakeCount = await countOf(mistakesCol(uid).where('topicId', '==', topicId));
        if (mistakeCount === 0) return fail(res, 409, 'Chủ đề này chưa có câu sai nào để làm căn cứ tạo câu luyện', 'no-mistakes');

        const active = await db.collection('jobs').where('ownerId', '==', uid).where('status', 'in', ['queued', 'running']).limit(20).get();
        if (active.docs.filter((d) => d.data().type === 'generate_practice').length >= MAX_ACTIVE_PRACTICE_JOBS) {
            return fail(res, 429, 'Đang có job tạo câu luyện chạy, vui lòng chờ xong', 'too-many-jobs');
        }

        const jobRef = db.collection('jobs').doc();
        const period = currentPeriod();
        try {
            await reserveCredits({
                uid,
                jobId: jobRef.id,
                amount: count,
                limit: creditLimits(plan),
                writes: (tx) =>
                    tx.set(jobRef, {
                        type: 'generate_practice',
                        ownerId: uid,
                        topicId,
                        count,
                        types: ['single'], // V1: chỉ trắc nghiệm 4 lựa chọn (dễ kiểm tra, chấm tự động)
                        credits: { period, reserved: count },
                        status: 'queued',
                        attempts: 0,
                        maxAttempts: 3,
                        progress: { done: 0, total: 1 },
                        error: null,
                        deadLetter: false,
                        runAfter: FieldValue.serverTimestamp(),
                        createdAt: FieldValue.serverTimestamp(),
                        updatedAt: FieldValue.serverTimestamp()
                    })
            });
        } catch (err) {
            if (err instanceof QuotaError) {
                return fail(res, 402, err.message, 'quota-credits', { resetsAt: err.resetsAt, window: err.window });
            }
            throw err;
        }

        wakeWorker();
        res.status(202).json({ status: 'success', jobId: jobRef.id, credits: { period, reserved: count } });
    }
);

// Câu đã duyệt trong ngân hàng của người dùng kèm đáp án. Câu của người khác, câu chưa duyệt, câu trả lời ngắn bị bỏ qua. -> Map(id -> { q, key })
async function loadBank(uid, ids) {
    const out = new Map();
    if (!ids.length) return out;
    const db = getDb();
    const [qSnaps, kSnaps] = await Promise.all([
        db.getAll(...ids.map((id) => db.collection('questions').doc(id))),
        db.getAll(...ids.map((id) => db.collection('answerKeys').doc(id)))
    ]);
    qSnaps.forEach((s, i) => {
        if (!s.exists || !kSnaps[i].exists) return;
        const q = s.data();
        const usable = q.reviewStatus === 'approved' || q.origin === 'ai-practice';
        if (q.ownerId !== uid || !usable || q.type === 'short' || !q.topicId) return;
        out.set(s.id, { q, key: kSnaps[i].data() });
    });
    return out;
}

export default router;

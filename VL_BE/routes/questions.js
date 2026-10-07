// Chức năng: API câu hỏi (Phase 3) - tạo job sinh câu hỏi từ tài liệu (giữ chỗ AI credits), xem tiến độ job,
// danh sách/sửa/duyệt/xóa câu hỏi, xem nguồn (đoạn tài liệu gốc) của từng câu.
import { Router } from 'express';
import { z } from 'zod';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../firebase.js';
import { requireRole, requireOwner } from '../middleware/permissions.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { creditLimits, getPlan } from '../config/plans.js';
import { QuotaError, currentPeriod, getBalance, reserveCredits } from '../credits.js';
import { QUESTION_TYPES, parseQuestion, splitForStorage } from '../ai/questionRules.js';
import { wakeWorker } from '../worker/index.js';

const router = Router();
const userOnly = requireRole(['user']);

const MAX_ACTIVE_JOBS = 2; // mỗi người tối đa 2 job sinh câu hỏi chạy cùng lúc
const questions = () => getDb().collection('questions');
const answerKeys = () => getDb().collection('answerKeys');

function fail(res, status, message, code, extra) {
    return res.status(status).json({ status: 'error', message, ...(code ? { code } : {}), ...(extra || {}) });
}

const iso = (ts) => (ts?.toDate ? ts.toDate().toISOString() : null);

// Câu hỏi trả về cho CHỦ SỞ HỮU (màn hình duyệt) nên kèm đáp án. Người làm bài (Phase 4) sẽ KHÔNG nhận trường "answer".
function toPublic(id, q, key) {
    return {
        id,
        type: q.type,
        topicId: q.topicId,
        stem: q.stem,
        options: q.options || [],
        explanation: q.explanation || '',
        source: q.source || null,
        reviewStatus: q.reviewStatus,
        jobId: q.jobId || null,
        createdAt: iso(q.createdAt),
        ...(key ? { answer: { correct: key.correct, alternatives: key.alternatives || [] } } : {})
    };
}

// Dựng lại dạng "thô" của câu hỏi để chạy lại luật kiểm tra (parseQuestion)
function rebuildRaw(q, key, patch = {}) {
    const raw = {
        type: q.type,
        chunkId: q.source?.chunkId,
        stem: q.stem,
        explanation: q.explanation || undefined,
        correct: key?.correct,
        ...(key?.alternatives ? { alternatives: key.alternatives } : {})
    };
    if (q.type === 'single' || q.type === 'multi') raw.options = q.options;
    return { ...raw, ...patch };
}

// ---------------------------------------------------------------------------
// AI credits còn lại hôm nay và trong tuần
// ---------------------------------------------------------------------------
router.get('/credits', userOnly, async (req, res) => {
    const plan = getPlan(req.profile.plan);
    const balance = await getBalance(req.actor.id, creditLimits(plan));
    res.status(200).json({ status: 'success', credits: balance });
});

// ---------------------------------------------------------------------------
// Tạo job sinh câu hỏi: kiểm tra quota -> giữ chỗ credits + tạo job trong CÙNG một transaction
// ---------------------------------------------------------------------------
const generateSchema = z
    .object({
        documentId: z.string().min(1).max(100),
        topicId: z.string().min(1).max(100),
        count: z.number().int().min(1).max(100),
        types: z.array(z.enum(QUESTION_TYPES)).min(1).max(QUESTION_TYPES.length).default(['single']),
        pageFrom: z.number().int().min(1).optional(),
        pageTo: z.number().int().min(1).optional()
    })
    .strict()
    .refine((v) => !v.pageFrom || !v.pageTo || v.pageFrom <= v.pageTo, 'pageFrom phải <= pageTo');

const generateLimiter = rateLimit({ windowMs: 60_000, max: 5, name: 'questions-generate' });

router.post('/generate', generateLimiter, userOnly, async (req, res) => {
    const parsed = generateSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'Dữ liệu không hợp lệ');

    const { documentId, topicId, count, pageFrom, pageTo } = parsed.data;
    const types = [...new Set(parsed.data.types)];
    const uid = req.actor.id;
    const plan = getPlan(req.profile.plan);

    if (count > plan.maxQuestionsPerJob) {
        return fail(res, 400, `Mỗi lần chỉ tạo tối đa ${plan.maxQuestionsPerJob} câu`, 'count-too-large');
    }

    const db = getDb();
    const [docSnap, topicSnap] = await Promise.all([
        db.collection('documents').doc(documentId).get(),
        db.collection('topics').doc(topicId).get()
    ]);
    if (!docSnap.exists || docSnap.data().ownerId !== uid) return fail(res, 404, 'Không tìm thấy tài liệu');
    if (docSnap.data().status !== 'ready') return fail(res, 409, 'Tài liệu chưa sẵn sàng', 'not-ready');
    if (!topicSnap.exists || topicSnap.data().ownerId !== uid) return fail(res, 404, 'Không tìm thấy chủ đề');

    // Chặn bấm liên tục: đang có quá nhiều job chạy thì chưa nhận thêm
    const active = await db
        .collection('jobs')
        .where('ownerId', '==', uid)
        .where('status', 'in', ['queued', 'running'])
        .limit(20)
        .get();
    if (active.docs.filter((d) => d.data().type === 'generate_questions').length >= MAX_ACTIVE_JOBS) {
        return fail(res, 429, 'Đang có job tạo câu hỏi chạy, vui lòng chờ xong', 'too-many-jobs');
    }

    const jobRef = db.collection('jobs').doc();
    const period = currentPeriod();
    try {
        await reserveCredits({
            uid,
            jobId: jobRef.id,
            amount: count, // 1 credit = 1 câu hỏi; dùng ít hơn thì hoàn phần dư khi job xong
            limit: creditLimits(plan),
            writes: (tx) =>
                tx.set(jobRef, {
                    type: 'generate_questions',
                    ownerId: uid,
                    documentId,
                    topicId,
                    count,
                    types,
                    pageFrom: pageFrom ?? null,
                    pageTo: pageTo ?? null,
                    credits: { period, reserved: count },
                    status: 'queued',
                    attempts: 0,
                    maxAttempts: 3,
                    progress: { done: 0, total: null },
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
});

// Tiến độ một job
router.get(
    '/jobs/:jobId',
    requireOwner(async (req) => {
        const snap = await getDb().collection('jobs').doc(req.params.jobId).get();
        req.jobSnap = snap.exists ? snap : null;
        return req.jobSnap ? req.jobSnap.data().ownerId : null;
    }),
    (req, res) => {
        if (!req.jobSnap) return fail(res, 404, 'Không tìm thấy job');
        const j = req.jobSnap.data();
        res.status(200).json({
            status: 'success',
            job: {
                id: req.jobSnap.id,
                type: j.type,
                status: j.status,
                progress: j.progress || null,
                error: j.error || null,
                result: j.result || null
            }
        });
    }
);

// ---------------------------------------------------------------------------
// Duyệt hàng loạt (đặt TRƯỚC các route /:id)
// ---------------------------------------------------------------------------
const approveManySchema = z.object({ ids: z.array(z.string().min(1).max(100)).min(1).max(50) }).strict();

router.post('/approve-many', userOnly, async (req, res) => {
    const parsed = approveManySchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'Dữ liệu không hợp lệ');

    const ids = [...new Set(parsed.data.ids)];
    const db = getDb();
    const [qSnaps, kSnaps] = await Promise.all([
        db.getAll(...ids.map((id) => questions().doc(id))),
        db.getAll(...ids.map((id) => answerKeys().doc(id)))
    ]);

    const batch = db.batch();
    let approved = 0;
    qSnaps.forEach((qs, i) => {
        if (!qs.exists || qs.data().ownerId !== req.actor.id) return;
        if (qs.data().reviewStatus === 'approved') return;
        const check = parseQuestion(rebuildRaw(qs.data(), kSnaps[i].data()));
        if (!check.ok) return; // câu thiếu/hỏng đáp án thì không cho duyệt
        batch.update(qs.ref, { reviewStatus: 'approved', updatedAt: FieldValue.serverTimestamp() });
        approved++;
    });
    if (approved) await batch.commit();

    res.status(200).json({ status: 'success', approved, skipped: ids.length - approved });
});

// ---------------------------------------------------------------------------
// Danh sách câu hỏi của tôi (lọc theo chủ đề, tài liệu, job, trạng thái duyệt)
// ---------------------------------------------------------------------------
const listSchema = z.object({
    topicId: z.string().max(100).optional(),
    documentId: z.string().max(100).optional(),
    jobId: z.string().max(100).optional(),
    reviewStatus: z.enum(['draft', 'approved']).optional()
});

router.get('/', userOnly, async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return fail(res, 400, 'Bộ lọc không hợp lệ');
    const { topicId, documentId, jobId, reviewStatus } = parsed.data;

    const snap = await questions().where('ownerId', '==', req.actor.id).limit(300).get();
    let items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (topicId) items = items.filter((q) => q.topicId === topicId);
    if (documentId) items = items.filter((q) => q.source?.documentId === documentId);
    if (jobId) items = items.filter((q) => q.jobId === jobId);
    if (reviewStatus) items = items.filter((q) => q.reviewStatus === reviewStatus);
    items.sort((a, b) => a.id.localeCompare(b.id) || 0);

    // Ghép đáp án để màn hình duyệt hiển thị (chỉ chủ sở hữu mới gọi được route này)
    const keys = items.length ? await getDb().getAll(...items.map((q) => answerKeys().doc(q.id))) : [];
    res.status(200).json({
        status: 'success',
        questions: items.map((q, i) => toPublic(q.id, q, keys[i].data()))
    });
});

// ---------------------------------------------------------------------------
// Một câu hỏi
// ---------------------------------------------------------------------------
const ownerOnly = requireOwner(async (req) => {
    const snap = await questions().doc(req.params.id).get();
    req.qSnap = snap.exists ? snap : null;
    return req.qSnap ? req.qSnap.data().ownerId : null;
});

router.get('/:id', ownerOnly, async (req, res) => {
    if (!req.qSnap) return fail(res, 404, 'Không tìm thấy câu hỏi');
    const key = await answerKeys().doc(req.qSnap.id).get();
    res.status(200).json({ status: 'success', question: toPublic(req.qSnap.id, req.qSnap.data(), key.data()) });
});

// Nút "Xem nguồn": trả đoạn tài liệu gốc làm căn cứ cho câu hỏi
router.get('/:id/source', ownerOnly, async (req, res) => {
    if (!req.qSnap) return fail(res, 404, 'Không tìm thấy câu hỏi');
    const src = req.qSnap.data().source;
    if (!src?.documentId || !src?.chunkId) return fail(res, 404, 'Câu hỏi không có nguồn');

    const chunk = await getDb().collection('documents').doc(src.documentId).collection('chunks').doc(src.chunkId).get();
    if (!chunk.exists) return fail(res, 404, 'Đoạn nguồn không còn tồn tại (tài liệu có thể đã bị xóa)', 'source-missing');

    res.status(200).json({
        status: 'success',
        source: { documentId: src.documentId, pageNumber: src.pageNumber, chunkId: src.chunkId, text: chunk.data().text }
    });
});

// Sửa tay: chạy lại đúng luật kiểm tra như câu AI sinh; sửa xong về trạng thái "nháp" để duyệt lại
const editSchema = z
    .object({
        stem: z.string().optional(),
        options: z.array(z.string()).optional(),
        correct: z.union([z.number(), z.array(z.number()), z.boolean(), z.string()]).optional(),
        alternatives: z.array(z.string()).optional(),
        explanation: z.string().optional(),
        topicId: z.string().min(1).max(100).optional()
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0);

router.patch('/:id', ownerOnly, async (req, res) => {
    if (!req.qSnap) return fail(res, 404, 'Không tìm thấy câu hỏi');
    const parsed = editSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'Dữ liệu không hợp lệ');

    const q = req.qSnap.data();
    const { topicId, ...patch } = parsed.data;

    if (topicId && topicId !== q.topicId) {
        const t = await getDb().collection('topics').doc(topicId).get();
        if (!t.exists || t.data().ownerId !== q.ownerId) return fail(res, 404, 'Không tìm thấy chủ đề');
    }

    const keySnap = await answerKeys().doc(req.qSnap.id).get();
    const check = parseQuestion(rebuildRaw(q, keySnap.data(), patch));
    if (!check.ok) return fail(res, 400, 'Câu hỏi sau khi sửa không hợp lệ', check.reason);

    const { question, key } = splitForStorage({ ...check.q, source: q.source });
    const batch = getDb().batch();
    batch.update(req.qSnap.ref, {
        stem: question.stem,
        options: question.options,
        explanation: question.explanation,
        ...(topicId ? { topicId } : {}),
        reviewStatus: 'draft',
        updatedAt: FieldValue.serverTimestamp()
    });
    batch.set(answerKeys().doc(req.qSnap.id), { ownerId: q.ownerId, ...key });
    await batch.commit();

    const fresh = await req.qSnap.ref.get();
    res.status(200).json({ status: 'success', question: toPublic(fresh.id, fresh.data(), key) });
});

router.post('/:id/approve', ownerOnly, async (req, res) => {
    if (!req.qSnap) return fail(res, 404, 'Không tìm thấy câu hỏi');
    const keySnap = await answerKeys().doc(req.qSnap.id).get();
    const check = parseQuestion(rebuildRaw(req.qSnap.data(), keySnap.data()));
    if (!check.ok) return fail(res, 400, 'Câu hỏi chưa hợp lệ, hãy sửa trước khi duyệt', check.reason);

    await req.qSnap.ref.update({ reviewStatus: 'approved', updatedAt: FieldValue.serverTimestamp() });
    res.status(200).json({ status: 'success', reviewStatus: 'approved' });
});

router.delete('/:id', ownerOnly, async (req, res) => {
    if (!req.qSnap) return fail(res, 404, 'Không tìm thấy câu hỏi');
    const batch = getDb().batch();
    batch.delete(req.qSnap.ref);
    batch.delete(answerKeys().doc(req.qSnap.id));
    await batch.commit();
    res.status(200).json({ status: 'success', message: 'Đã xóa câu hỏi' });
});

export default router;

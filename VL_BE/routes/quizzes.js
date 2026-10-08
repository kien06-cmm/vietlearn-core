// Chức năng: API Quiz (Phase 4) - tạo/sửa bản nháp, cài đặt (thời gian, số lần làm, xáo trộn), publish bất biến (mỗi lần publish tạo version mới), xem version, sao chép (fork), xóa mềm.
import { Router } from 'express';
import { z } from 'zod';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../firebase.js';
import { requireRole, requireOwner } from '../middleware/permissions.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { parseQuestion } from '../ai/questionRules.js';
import {
    MAX_QUESTIONS_PER_QUIZ,
    MAX_QUIZZES,
    buildSnapshot,
    dedupeIds,
    draftHash,
    hashOf,
    mergeSettings,
    rawOf
} from '../quiz/quizRules.js';

const router = Router();
const userOnly = requireRole(['user']);

const quizzes = () => getDb().collection('quizzes');
const versions = () => getDb().collection('quizVersions');
const versionKeys = () => getDb().collection('quizVersionKeys');
const questions = () => getDb().collection('questions');
const answerKeys = () => getDb().collection('answerKeys');

const iso = (ts) => (ts?.toDate ? ts.toDate().toISOString() : null);
const millis = (ts) => (ts?.toMillis ? ts.toMillis() : 0);

class QuizError extends Error {
    constructor(status, message, code, extra) {
        super(message);
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}

function fail(res, status, message, code, extra) {
    return res.status(status).json({ status: 'error', message, ...(code ? { code } : {}), ...(extra || {}) });
}

function sendError(res, err) {
    if (err instanceof QuizError) return fail(res, err.status, err.message, err.code, err.extra);
    throw err;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const settingsPatch = z
    .object({
        timeLimitMinutes: z.number().int().min(1).max(300).nullable().optional(),
        maxAttempts: z.number().int().min(1).max(20).nullable().optional(),
        shuffleQuestions: z.boolean().optional(),
        shuffleOptions: z.boolean().optional()
    })
    .strict();

const idList = z.array(z.string().min(1).max(100)).max(MAX_QUESTIONS_PER_QUIZ);

const createSchema = z
    .object({
        title: z.string().trim().min(1).max(100),
        description: z.string().trim().max(500).optional(),
        questionIds: idList.optional(),
        settings: settingsPatch.optional()
    })
    .strict();

const patchSchema = z
    .object({
        title: z.string().trim().min(1).max(100).optional(),
        description: z.string().trim().max(500).optional(),
        questionIds: idList.optional(),
        settings: settingsPatch.optional()
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0);

const forkSchema = z.object({ version: z.number().int().min(1).optional() }).strict();

// ---------------------------------------------------------------------------
// Hỗ trợ
// ---------------------------------------------------------------------------
function toPublic(id, d) {
    return {
        id,
        title: d.title,
        description: d.description || '',
        questionCount: d.questionIds.length,
        settings: d.settings,
        currentVersion: d.currentVersion || 0,
        hasUnpublishedChanges: d.draftHash !== d.publishedDraftHash,
        forkedFrom: d.forkedFrom || null,
        publishedAt: iso(d.publishedAt),
        createdAt: iso(d.createdAt),
        updatedAt: iso(d.updatedAt)
    };
}

// Đọc các câu hỏi của chủ sở hữu theo đúng thứ tự. Mỗi câu phải tồn tại, đã duyệt và qua luật kiểm tra
async function loadApproved(uid, ids) {
    if (!ids.length) return [];
    const db = getDb();
    const [qSnaps, kSnaps] = await Promise.all([
        db.getAll(...ids.map((id) => questions().doc(id))),
        db.getAll(...ids.map((id) => answerKeys().doc(id)))
    ]);
    return qSnaps.map((qs, i) => {
        const id = ids[i];
        if (!qs.exists || qs.data().ownerId !== uid) {
            throw new QuizError(404, 'Có câu hỏi không tồn tại hoặc không thuộc về bạn', 'question-missing', { questionId: id });
        }
        const q = qs.data();
        if (q.reviewStatus !== 'approved') {
            throw new QuizError(400, 'Chỉ dùng được câu hỏi đã duyệt', 'question-not-approved', { questionId: id });
        }
        const key = kSnaps[i].data();
        if (!parseQuestion(rawOf(q, key)).ok) {
            throw new QuizError(400, 'Có câu hỏi lỗi đáp án, hãy sửa trước', 'question-invalid', { questionId: id });
        }
        return { id, q, key };
    });
}

// Giống loadApproved nhưng bỏ qua câu không dùng được (dùng khi sao chép)
async function filterUsable(uid, ids) {
    const kept = [];
    for (const id of ids) {
        try {
            await loadApproved(uid, [id]);
            kept.push(id);
        } catch (err) {
            if (!(err instanceof QuizError)) throw err;
        }
    }
    return kept;
}

async function countMine(uid) {
    const snap = await quizzes().where('ownerId', '==', uid).limit(300).get();
    return snap.docs.filter((d) => !d.data().deletedAt).length;
}

function newQuizDoc({ uid, title, description, questionIds, settings, forkedFrom }) {
    return {
        ownerId: uid,
        title,
        description: description || '',
        questionIds,
        settings,
        draftHash: draftHash({ title, description, questionIds, settings }),
        publishedDraftHash: null,
        lastContentHash: null,
        currentVersion: 0,
        forkedFrom: forkedFrom || null,
        publishedAt: null,
        deletedAt: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
    };
}

const ownerOnly = requireOwner(async (req) => {
    const snap = await quizzes().doc(req.params.id).get();
    req.quizSnap = snap.exists && !snap.data().deletedAt ? snap : null;
    return req.quizSnap ? req.quizSnap.data().ownerId : null;
});

const createLimiter = rateLimit({ windowMs: 60_000, max: 20, name: 'quizzes-create' });
const publishLimiter = rateLimit({ windowMs: 60_000, max: 10, name: 'quizzes-publish' });

// ---------------------------------------------------------------------------
// Danh sách quiz của tôi
// ---------------------------------------------------------------------------
router.get('/', userOnly, async (req, res) => {
    const snap = await quizzes().where('ownerId', '==', req.actor.id).limit(300).get();
    const items = snap.docs
        .filter((d) => !d.data().deletedAt)
        .sort((a, b) => millis(b.data().updatedAt) - millis(a.data().updatedAt))
        .map((d) => toPublic(d.id, d.data()));
    res.status(200).json({ status: 'success', quizzes: items });
});

// ---------------------------------------------------------------------------
// Tạo quiz (bản nháp)
// ---------------------------------------------------------------------------
router.post('/', createLimiter, userOnly, async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'Dữ liệu không hợp lệ');

    const uid = req.actor.id;
    if ((await countMine(uid)) >= MAX_QUIZZES) return fail(res, 403, 'Đã đạt giới hạn số quiz', 'quota-quizzes');

    const questionIds = dedupeIds(parsed.data.questionIds || []);
    try {
        await loadApproved(uid, questionIds);
    } catch (err) {
        return sendError(res, err);
    }

    const ref = quizzes().doc();
    await ref.set(
        newQuizDoc({
            uid,
            title: parsed.data.title,
            description: parsed.data.description,
            questionIds,
            settings: mergeSettings(null, parsed.data.settings)
        })
    );
    const fresh = await ref.get();
    res.status(201).json({ status: 'success', quiz: toPublic(ref.id, fresh.data()) });
});

// ---------------------------------------------------------------------------
// Chi tiết quiz: bản nháp kèm danh sách câu hỏi (không kèm đáp án)
// ---------------------------------------------------------------------------
router.get('/:id', ownerOnly, async (req, res) => {
    if (!req.quizSnap) return fail(res, 404, 'Không tìm thấy quiz');
    const d = req.quizSnap.data();

    const snaps = d.questionIds.length ? await getDb().getAll(...d.questionIds.map((id) => questions().doc(id))) : [];
    const list = snaps.map((s, i) => {
        if (!s.exists) return { id: d.questionIds[i], missing: true };
        const q = s.data();
        return { id: s.id, type: q.type, topicId: q.topicId, stem: q.stem, reviewStatus: q.reviewStatus, missing: false };
    });

    res.status(200).json({ status: 'success', quiz: { ...toPublic(req.quizSnap.id, d), questions: list } });
});

// ---------------------------------------------------------------------------
// Sửa bản nháp (không đụng tới các version đã publish)
// ---------------------------------------------------------------------------
router.patch('/:id', ownerOnly, async (req, res) => {
    if (!req.quizSnap) return fail(res, 404, 'Không tìm thấy quiz');
    const parsed = patchSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'Dữ liệu không hợp lệ');

    const d = req.quizSnap.data();
    const title = parsed.data.title ?? d.title;
    const description = parsed.data.description ?? d.description ?? '';
    const settings = mergeSettings(d.settings, parsed.data.settings);
    const questionIds = parsed.data.questionIds ? dedupeIds(parsed.data.questionIds) : d.questionIds;

    if (parsed.data.questionIds) {
        try {
            await loadApproved(d.ownerId, questionIds);
        } catch (err) {
            return sendError(res, err);
        }
    }

    await req.quizSnap.ref.update({
        title,
        description,
        questionIds,
        settings,
        draftHash: draftHash({ title, description, questionIds, settings }),
        updatedAt: FieldValue.serverTimestamp()
    });
    const fresh = await req.quizSnap.ref.get();
    res.status(200).json({ status: 'success', quiz: toPublic(fresh.id, fresh.data()) });
});

// ---------------------------------------------------------------------------
// Xóa mềm (các version đã publish vẫn giữ để phòng/kết quả cũ còn tham chiếu)
// ---------------------------------------------------------------------------
router.delete('/:id', ownerOnly, async (req, res) => {
    if (!req.quizSnap) return fail(res, 404, 'Không tìm thấy quiz');
    await req.quizSnap.ref.update({ deletedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    res.status(200).json({ status: 'success', message: 'Đã xóa quiz' });
});

// ---------------------------------------------------------------------------
// Publish: chụp nội dung hiện tại thành version mới, bất biến
// ---------------------------------------------------------------------------
router.post('/:id/publish', publishLimiter, ownerOnly, async (req, res) => {
    if (!req.quizSnap) return fail(res, 404, 'Không tìm thấy quiz');
    const d = req.quizSnap.data();
    if (!d.questionIds.length) return fail(res, 400, 'Quiz chưa có câu hỏi nào', 'empty-quiz');

    let items;
    try {
        items = await loadApproved(d.ownerId, d.questionIds);
    } catch (err) {
        return sendError(res, err);
    }

    const { questions: snapQuestions, keys } = buildSnapshot(items);
    const contentHash = hashOf({
        title: d.title,
        description: d.description || '',
        settings: d.settings,
        questions: snapQuestions,
        keys
    });
    const ref = req.quizSnap.ref;

    let version;
    try {
        version = await getDb().runTransaction(async (tx) => {
            const snap = await tx.get(ref);
            const cur = snap.data();
            if (!snap.exists || cur.deletedAt) throw new QuizError(404, 'Không tìm thấy quiz');
            if (cur.draftHash !== d.draftHash) {
                throw new QuizError(409, 'Quiz vừa được sửa, hãy thử lại', 'draft-changed');
            }
            if (cur.lastContentHash === contentHash) {
                throw new QuizError(409, 'Chưa có thay đổi nào so với version đã publish', 'no-changes');
            }

            const next = (cur.currentVersion || 0) + 1;
            const vid = `${ref.id}_${next}`;
            tx.set(versions().doc(vid), {
                quizId: ref.id,
                ownerId: cur.ownerId,
                version: next,
                title: cur.title,
                description: cur.description || '',
                settings: cur.settings,
                questionCount: snapQuestions.length,
                questions: snapQuestions,
                contentHash,
                createdAt: FieldValue.serverTimestamp()
            });
            tx.set(versionKeys().doc(vid), { quizId: ref.id, ownerId: cur.ownerId, version: next, keys });
            tx.update(ref, {
                currentVersion: next,
                publishedDraftHash: cur.draftHash,
                lastContentHash: contentHash,
                publishedAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp()
            });
            return next;
        });
    } catch (err) {
        return sendError(res, err);
    }

    const fresh = await ref.get();
    res.status(201).json({ status: 'success', version, quiz: toPublic(fresh.id, fresh.data()) });
});

// ---------------------------------------------------------------------------
// Các version đã publish
// ---------------------------------------------------------------------------
router.get('/:id/versions', ownerOnly, async (req, res) => {
    if (!req.quizSnap) return fail(res, 404, 'Không tìm thấy quiz');
    const snap = await versions().where('quizId', '==', req.quizSnap.id).limit(100).get();
    const list = snap.docs
        .map((s) => s.data())
        .sort((a, b) => b.version - a.version)
        .map((v) => ({
            version: v.version,
            title: v.title,
            questionCount: v.questionCount,
            settings: v.settings,
            createdAt: iso(v.createdAt)
        }));
    res.status(200).json({ status: 'success', versions: list });
});

router.get('/:id/versions/:version', ownerOnly, async (req, res) => {
    if (!req.quizSnap) return fail(res, 404, 'Không tìm thấy quiz');
    const n = Number(req.params.version);
    if (!Number.isInteger(n) || n < 1) return fail(res, 400, 'Số version không hợp lệ');

    const snap = await versions().doc(`${req.quizSnap.id}_${n}`).get();
    if (!snap.exists) return fail(res, 404, 'Không tìm thấy version');
    const v = snap.data();
    res.status(200).json({
        status: 'success',
        version: {
            version: v.version,
            title: v.title,
            description: v.description,
            settings: v.settings,
            questionCount: v.questionCount,
            questions: v.questions,
            createdAt: iso(v.createdAt)
        }
    });
});

// ---------------------------------------------------------------------------
// Sao chép (fork): tạo quiz mới từ bản nháp hiện tại hoặc từ một version đã publish
// ---------------------------------------------------------------------------
router.post('/:id/fork', createLimiter, ownerOnly, async (req, res) => {
    if (!req.quizSnap) return fail(res, 404, 'Không tìm thấy quiz');
    const parsed = forkSchema.safeParse(req.body ?? {});
    if (!parsed.success) return fail(res, 400, 'Dữ liệu không hợp lệ');

    const d = req.quizSnap.data();
    const uid = d.ownerId;
    if ((await countMine(uid)) >= MAX_QUIZZES) return fail(res, 403, 'Đã đạt giới hạn số quiz', 'quota-quizzes');

    const fromVersion = parsed.data.version ?? null;
    let source = { title: d.title, description: d.description, settings: d.settings, ids: d.questionIds };
    if (fromVersion) {
        const vs = await versions().doc(`${req.quizSnap.id}_${fromVersion}`).get();
        if (!vs.exists) return fail(res, 404, 'Không tìm thấy version');
        const v = vs.data();
        source = { title: v.title, description: v.description, settings: v.settings, ids: v.questions.map((q) => q.id) };
    }

    const questionIds = await filterUsable(uid, source.ids);
    const ref = quizzes().doc();
    await ref.set(
        newQuizDoc({
            uid,
            title: `${source.title.slice(0, 90)} (bản sao)`,
            description: source.description,
            questionIds,
            settings: mergeSettings(null, source.settings),
            forkedFrom: { quizId: req.quizSnap.id, version: fromVersion }
        })
    );
    const fresh = await ref.get();
    res.status(201).json({
        status: 'success',
        dropped: source.ids.length - questionIds.length,
        quiz: toPublic(ref.id, fresh.data())
    });
});

export default router;

// Chức năng: API làm bài (Phase 4) - mở lượt làm (seed + xáo trộn do server quyết định, giới hạn số lần, tiếp tục lượt đang dở), lưu nháp tự động, nộp bài (chấm ở server, nộp nhiều lần vẫn chỉ chấm một lần), xem lại kết quả, ghi sự kiện chống gian lận.
// Đáp án đúng nằm ở quizVersionKeys và chỉ được đọc khi chấm hoặc khi xem lại SAU KHI đã nộp.
// Hiện lượt làm do chủ quiz tự mở (làm thử). Phòng làm bài (bước sau) dùng lại openAttempt với roomId.
import { Router } from 'express';
import { z } from 'zod';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../firebase.js';
import { requireRole } from '../middleware/permissions.js';
import { rateLimit } from '../middleware/rateLimit.js';
import {
    EVENT_TYPES,
    MAX_EVENTS,
    buildAttemptView,
    buildReview,
    cleanAnswers,
    computeDeadline,
    gradeAttempt,
    isPastDeadline,
    mergeAnswers,
    newSeed
} from '../quiz/gradingRules.js';

const router = Router();
const anyActor = requireRole(['user', 'guest']);
const userOnly = requireRole(['user']);

const attempts = () => getDb().collection('attempts');
const counters = () => getDb().collection('attemptCounters');
const quizzes = () => getDb().collection('quizzes');
const versions = () => getDb().collection('quizVersions');
const versionKeys = () => getDb().collection('quizVersionKeys');

// Cả lớp thường chung một mạng Wi-Fi (cùng IP) nên giới hạn theo IP ở đây rộng; giới hạn chặt nằm ở từng người làm bài bên dưới
router.use(rateLimit({ windowMs: 60_000, max: 1200, name: 'attempts-ip' }));
const actorLimit = (name, max) => rateLimit({ windowMs: 60_000, max, name, keyFn: (req) => req.actor?.id });

const millisOf = (v) => (v?.toMillis ? v.toMillis() : v instanceof Date ? v.getTime() : null);
const iso = (v) => {
    const ms = millisOf(v);
    return ms == null ? null : new Date(ms).toISOString();
};

class AttemptError extends Error {
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

// Bọc handler: lỗi nghiệp vụ trả về JSON tiếng Việt, lỗi khác để Express xử lý (500)
const handle = (fn) => async (req, res) => {
    try {
        await fn(req, res);
    } catch (err) {
        if (err instanceof AttemptError) return fail(res, err.status, err.message, err.code, err.extra);
        throw err;
    }
};

// ---------------------------------------------------------------------------
// Đọc version và đáp án. Version đã publish là bất biến nên cache trong bộ nhớ được (đỡ 1 lượt đọc mỗi lần lưu nháp).
// Đáp án KHÔNG cache, chỉ đọc khi chấm hoặc xem lại.
// ---------------------------------------------------------------------------
const versionCache = new Map();
const VERSION_CACHE_MAX = 50;

async function loadVersion(quizId, n) {
    const id = `${quizId}_${n}`;
    if (versionCache.has(id)) {
        const hit = versionCache.get(id);
        versionCache.delete(id); // đưa lên cuối để giữ mục dùng gần đây
        versionCache.set(id, hit);
        return hit;
    }
    const snap = await versions().doc(id).get();
    if (!snap.exists) throw new AttemptError(404, 'Không tìm thấy version của quiz');
    const data = snap.data();
    versionCache.set(id, data);
    if (versionCache.size > VERSION_CACHE_MAX) versionCache.delete(versionCache.keys().next().value);
    return data;
}

async function loadKeys(quizId, n) {
    const snap = await versionKeys().doc(`${quizId}_${n}`).get();
    if (!snap.exists) throw new Error(`Thiếu đáp án của version ${quizId}_${n}`);
    return snap.data().keys;
}

// ---------------------------------------------------------------------------
// Hỗ trợ
// ---------------------------------------------------------------------------
const isMine = (a, actor) => a.participant?.type === actor.type && a.participant?.id === actor.id;

// Chỉ chính người làm mới thấy lượt làm của mình. Không phải của mình thì trả 404 (không tiết lộ lượt làm có tồn tại)
async function loadMine(req) {
    const id = req.params.id;
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new AttemptError(404, 'Không tìm thấy lượt làm bài');
    const snap = await attempts().doc(id).get();
    if (!snap.exists || !isMine(snap.data(), req.actor)) throw new AttemptError(404, 'Không tìm thấy lượt làm bài');
    return snap;
}

function toPublicAttempt(id, a) {
    return {
        id,
        quizId: a.quizId,
        version: a.quizVersion,
        title: a.title,
        status: a.status, // in_progress | submitted
        startedAt: iso(a.startedAt),
        deadlineAt: iso(a.deadlineAt),
        timeLimitMinutes: a.timeLimitMinutes ?? null,
        savedAt: iso(a.savedAt),
        submittedAt: iso(a.submittedAt),
        submitReason: a.submitReason || null, // submitted | timeout
        answers: a.answers || {},
        result: a.result || null
    };
}

const deadlineOf = (a) => millisOf(a.deadlineAt);

// ---------------------------------------------------------------------------
// Chốt bài và chấm điểm. Chạy trong transaction nên nộp nhiều lần/ nộp song song vẫn chỉ chấm đúng một lần.
// patch: câu trả lời cuối cùng đã làm sạch (bỏ qua nếu đã quá hạn: khi đó chấm theo bản đã lưu).
// ---------------------------------------------------------------------------
async function finalizeAttempt(attemptId, { patch = null, reason = 'submitted' } = {}) {
    const ref = attempts().doc(attemptId);
    const pre = await ref.get();
    if (!pre.exists) throw new AttemptError(404, 'Không tìm thấy lượt làm bài');
    const a0 = pre.data();
    if (a0.status === 'submitted') return { already: true, attempt: a0 };

    // Version và đáp án bất biến nên đọc trước transaction an toàn
    const [version, keys] = await Promise.all([loadVersion(a0.quizId, a0.quizVersion), loadKeys(a0.quizId, a0.quizVersion)]);
    const counterRef = counters().doc(a0.counterId);

    return getDb().runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const a = snap.data();
        if (a.status === 'submitted') return { already: true, attempt: a };

        const nowMs = Date.now();
        const late = isPastDeadline(deadlineOf(a), nowMs);
        const answers = patch && !late ? mergeAnswers(a.answers, patch) : a.answers || {};
        const result = gradeAttempt(version.questions, keys, answers);
        const submitReason = late ? 'timeout' : reason;
        const submittedAt = new Date(nowMs);

        tx.update(ref, { status: 'submitted', answers, result, submittedAt, submitReason, updatedAt: FieldValue.serverTimestamp() });
        // Giải phóng "lượt đang làm" để người làm có thể mở lượt mới (nếu còn số lần)
        tx.set(counterRef, { activeAttemptId: null, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
        return { already: false, attempt: { ...a, status: 'submitted', answers, result, submittedAt, submitReason } };
    });
}

// ---------------------------------------------------------------------------
// Mở lượt làm. Mỗi (người làm, quiz) có một bộ đếm attemptCounters để:
//  - chặn quá số lần làm tối đa (kể cả khi bấm "Bắt đầu" hai lần cùng lúc)
//  - tiếp tục lượt đang dở thay vì tạo lượt mới (mất mạng, tải lại trang)
// Trả { createdId } hoặc { resumedId }.
// ---------------------------------------------------------------------------
async function openAttempt({ actor, quizId, versionNumber, roomId = null }) {
    const version = await loadVersion(quizId, versionNumber);
    const maxAttempts = version.settings?.maxAttempts ?? null;
    const counterId = `${actor.type}_${actor.id}__${quizId}`;
    const counterRef = counters().doc(counterId);

    for (let round = 0; round < 2; round++) {
        const out = await getDb().runTransaction(async (tx) => {
            const cSnap = await tx.get(counterRef);
            const counter = cSnap.exists ? cSnap.data() : { count: 0, activeAttemptId: null };

            if (counter.activeAttemptId) {
                const aSnap = await tx.get(attempts().doc(counter.activeAttemptId));
                if (aSnap.exists && aSnap.data().status === 'in_progress') {
                    if (isPastDeadline(deadlineOf(aSnap.data()), Date.now())) return { expiredId: aSnap.id };
                    return { resumedId: aSnap.id };
                }
            }

            if (maxAttempts != null && counter.count >= maxAttempts) {
                throw new AttemptError(403, `Bạn đã dùng hết ${maxAttempts} lần làm bài`, 'max-attempts');
            }

            const ref = attempts().doc();
            const nowMs = Date.now();
            const deadlineMs = computeDeadline(nowMs, version.settings?.timeLimitMinutes ?? null);
            tx.set(ref, {
                quizId,
                quizVersion: versionNumber,
                title: version.title,
                ownerId: version.ownerId,
                participant: {
                    type: actor.type,
                    id: actor.id,
                    ...(actor.displayName ? { displayName: actor.displayName } : {})
                },
                participantKey: `${actor.type}:${actor.id}`,
                counterId,
                roomId,
                seed: newSeed(),
                status: 'in_progress',
                answers: {},
                events: [],
                timeLimitMinutes: version.settings?.timeLimitMinutes ?? null,
                startedAt: new Date(nowMs),
                deadlineAt: deadlineMs == null ? null : new Date(deadlineMs),
                savedAt: null,
                submittedAt: null,
                submitReason: null,
                result: null,
                createdAt: FieldValue.serverTimestamp(),
                updatedAt: FieldValue.serverTimestamp()
            });
            tx.set(counterRef, {
                actorType: actor.type,
                actorId: actor.id,
                quizId,
                count: counter.count + 1,
                activeAttemptId: ref.id,
                updatedAt: FieldValue.serverTimestamp()
            });
            return { createdId: ref.id };
        });

        // Lượt đang dở đã quá giờ: chấm theo bản đã lưu rồi thử mở lượt mới
        if (out.expiredId) {
            await finalizeAttempt(out.expiredId, { reason: 'timeout' });
            continue;
        }
        return out;
    }
    throw new AttemptError(409, 'Chưa mở được lượt làm bài, vui lòng thử lại', 'busy');
}

// Phản hồi chuẩn khi trả về một lượt đang làm: thông tin lượt + đề (không đáp án) + giờ server để đồng bộ đồng hồ đếm ngược
async function sendAttempt(res, snapId, a, httpStatus = 200, extra = {}) {
    let questions = null;
    if (a.status === 'in_progress') {
        const version = await loadVersion(a.quizId, a.quizVersion);
        questions = buildAttemptView(version.questions, version.settings, a.seed);
    }
    res.status(httpStatus).json({
        status: 'success',
        serverNow: new Date().toISOString(),
        attempt: toPublicAttempt(snapId, a),
        questions,
        ...extra
    });
}

// Hết giờ: chấm theo bản đã lưu và báo cho client
async function respondTimeUp(res, attemptId) {
    const out = await finalizeAttempt(attemptId, { reason: 'timeout' });
    return fail(res, 409, 'Đã hết giờ làm bài, bài của bạn đã được nộp tự động', 'time-up', { result: out.attempt.result });
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------
const startSchema = z
    .object({
        quizId: z.string().min(1).max(100),
        version: z.number().int().min(1).optional()
    })
    .strict();

const answersMap = z
    .record(z.string().min(1).max(100), z.unknown())
    .refine((m) => Object.keys(m).length <= 100, 'Tối đa 100 câu');

const saveSchema = z.object({ answers: answersMap }).strict();
const submitSchema = z.object({ answers: answersMap.optional() }).strict();
const eventSchema = z.object({ type: z.enum(EVENT_TYPES) }).strict();

// ---------------------------------------------------------------------------
// Bắt đầu làm bài (chủ quiz làm thử). Quiz phải đã publish; mặc định làm version mới nhất.
// ---------------------------------------------------------------------------
router.post(
    '/',
    userOnly,
    actorLimit('attempts-start', 20),
    handle(async (req, res) => {
        const parsed = startSchema.safeParse(req.body);
        if (!parsed.success) return fail(res, 400, 'Dữ liệu không hợp lệ');

        const quizSnap = await quizzes().doc(parsed.data.quizId).get();
        if (!quizSnap.exists || quizSnap.data().deletedAt || quizSnap.data().ownerId !== req.actor.id) {
            return fail(res, 404, 'Không tìm thấy quiz');
        }
        const versionNumber = parsed.data.version ?? quizSnap.data().currentVersion;
        if (!versionNumber) return fail(res, 409, 'Quiz chưa publish nên chưa làm bài được', 'not-published');

        const out = await openAttempt({ actor: req.actor, quizId: quizSnap.id, versionNumber });
        const id = out.createdId || out.resumedId;
        const snap = await attempts().doc(id).get();
        await sendAttempt(res, id, snap.data(), out.createdId ? 201 : 200, { resumed: Boolean(out.resumedId) });
    })
);

// ---------------------------------------------------------------------------
// Lịch sử lượt làm của tôi (tùy chọn lọc theo quizId)
// ---------------------------------------------------------------------------
router.get(
    '/',
    anyActor,
    actorLimit('attempts-list', 60),
    handle(async (req, res) => {
        let query = attempts().where('participantKey', '==', `${req.actor.type}:${req.actor.id}`);
        if (typeof req.query.quizId === 'string' && req.query.quizId) query = query.where('quizId', '==', req.query.quizId);

        const snap = await query.limit(100).get();
        const items = snap.docs
            .map((d) => ({ id: d.id, ...d.data() }))
            .sort((x, y) => (millisOf(y.startedAt) ?? 0) - (millisOf(x.startedAt) ?? 0))
            .map((a) => ({
                id: a.id,
                quizId: a.quizId,
                version: a.quizVersion,
                title: a.title,
                status: a.status,
                startedAt: iso(a.startedAt),
                submittedAt: iso(a.submittedAt),
                submitReason: a.submitReason || null,
                correct: a.result?.correct ?? null,
                gradable: a.result?.gradable ?? null,
                percent: a.result?.percent ?? null,
                score10: a.result?.score10 ?? null
            }));
        res.status(200).json({ status: 'success', attempts: items });
    })
);

// ---------------------------------------------------------------------------
// Mở lại một lượt (tải lại trang, reconnect): đề dựng lại đúng thứ tự từ seed, kèm câu trả lời đã lưu
// ---------------------------------------------------------------------------
router.get(
    '/:id',
    anyActor,
    actorLimit('attempts-read', 120),
    handle(async (req, res) => {
        const snap = await loadMine(req);
        let a = snap.data();
        if (a.status === 'in_progress' && isPastDeadline(deadlineOf(a), Date.now())) {
            a = (await finalizeAttempt(snap.id, { reason: 'timeout' })).attempt;
        }
        await sendAttempt(res, snap.id, a);
    })
);

// ---------------------------------------------------------------------------
// Lưu nháp tự động: chỉ gửi các câu vừa đổi; giá trị null là xóa câu trả lời
// ---------------------------------------------------------------------------
router.put(
    '/:id/answers',
    anyActor,
    actorLimit('attempts-save', 60),
    handle(async (req, res) => {
        const parsed = saveSchema.safeParse(req.body);
        if (!parsed.success) return fail(res, 400, 'Dữ liệu không hợp lệ');

        const snap = await loadMine(req);
        const a = snap.data();
        if (a.status !== 'in_progress') return fail(res, 409, 'Bài đã được nộp', 'already-submitted');
        if (isPastDeadline(deadlineOf(a), Date.now())) return respondTimeUp(res, snap.id);

        const version = await loadVersion(a.quizId, a.quizVersion);
        const { answers: patch, rejected } = cleanAnswers(version.questions, parsed.data.answers);

        const outcome = await getDb().runTransaction(async (tx) => {
            const fresh = await tx.get(snap.ref);
            const cur = fresh.data();
            if (cur.status !== 'in_progress') return 'submitted';
            if (isPastDeadline(deadlineOf(cur), Date.now())) return 'time-up';
            const savedAt = new Date();
            tx.update(snap.ref, { answers: mergeAnswers(cur.answers, patch), savedAt, updatedAt: FieldValue.serverTimestamp() });
            return savedAt;
        });

        if (outcome === 'submitted') return fail(res, 409, 'Bài đã được nộp', 'already-submitted');
        if (outcome === 'time-up') return respondTimeUp(res, snap.id);
        res.status(200).json({ status: 'success', savedAt: outcome.toISOString(), rejected });
    })
);

// ---------------------------------------------------------------------------
// Nộp bài. Có thể kèm câu trả lời cuối. Nộp lại bài đã nộp thì trả lại kết quả cũ (không chấm lần hai).
// Quá hạn thì bỏ phần gửi kèm và chấm theo bản đã lưu.
// ---------------------------------------------------------------------------
router.post(
    '/:id/submit',
    anyActor,
    actorLimit('attempts-submit', 20),
    handle(async (req, res) => {
        const parsed = submitSchema.safeParse(req.body ?? {});
        if (!parsed.success) return fail(res, 400, 'Dữ liệu không hợp lệ');

        const snap = await loadMine(req);
        const a = snap.data();

        let patch = null;
        if (a.status === 'in_progress' && parsed.data.answers) {
            const version = await loadVersion(a.quizId, a.quizVersion);
            patch = cleanAnswers(version.questions, parsed.data.answers).answers;
        }

        const out = await finalizeAttempt(snap.id, { patch, reason: 'submitted' });
        res.status(200).json({
            status: 'success',
            already: out.already,
            submitReason: out.attempt.submitReason ?? null,
            result: out.attempt.result
        });
    })
);

// ---------------------------------------------------------------------------
// Xem lại bài đã nộp: đáp án đúng, câu đã chọn, giải thích. Chưa nộp thì không được xem.
// ---------------------------------------------------------------------------
router.get(
    '/:id/result',
    anyActor,
    actorLimit('attempts-read', 120),
    handle(async (req, res) => {
        const snap = await loadMine(req);
        let a = snap.data();
        if (a.status === 'in_progress' && isPastDeadline(deadlineOf(a), Date.now())) {
            a = (await finalizeAttempt(snap.id, { reason: 'timeout' })).attempt;
        }
        if (a.status !== 'submitted') return fail(res, 409, 'Nộp bài xong mới xem được đáp án', 'not-submitted');

        const [version, keys] = await Promise.all([loadVersion(a.quizId, a.quizVersion), loadKeys(a.quizId, a.quizVersion)]);
        res.status(200).json({
            status: 'success',
            attempt: toPublicAttempt(snap.id, a),
            review: buildReview({
                questions: version.questions,
                settings: version.settings,
                seed: a.seed,
                keys,
                answers: a.answers,
                statuses: a.result?.statuses
            })
        });
    })
);

// ---------------------------------------------------------------------------
// Chống gian lận cơ bản: chỉ GHI NHẬN sự kiện (chuyển tab, mất focus, copy/paste), không tự khóa bài.
// Giao diện phải thông báo rõ cho người làm rằng dữ liệu này được ghi nhận.
// ---------------------------------------------------------------------------
router.post(
    '/:id/events',
    anyActor,
    actorLimit('attempts-events', 60),
    handle(async (req, res) => {
        const parsed = eventSchema.safeParse(req.body);
        if (!parsed.success) return fail(res, 400, 'Sự kiện không hợp lệ');

        const snap = await loadMine(req);
        const a = snap.data();
        // Bài đã nộp, đã hết giờ hoặc đã đủ số sự kiện: bỏ qua, không báo lỗi để giao diện không phải xử lý
        if (a.status !== 'in_progress' || isPastDeadline(deadlineOf(a), Date.now()) || (a.events || []).length >= MAX_EVENTS) {
            return res.status(202).json({ status: 'success', recorded: false });
        }

        await snap.ref.update({ events: FieldValue.arrayUnion({ type: parsed.data.type, at: Date.now() }) });
        res.status(202).json({ status: 'success', recorded: true });
    })
);

export default router;

// Chức năng: API Admin tối thiểu (Phase 6) - tìm người dùng theo email và đổi gói (free/pro) thủ công. Chỉ tài khoản có isAdmin = true (đọc từ Firestore, xem middleware/permissions.js).
// Mỗi lần đổi gói ghi một dòng vào adminAudit để biết ai đổi gì, khi nào.
import { Router } from 'express';
import { z } from 'zod';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../firebase.js';
import { requireAdmin } from '../middleware/permissions.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { PLAN_NAMES, isValidPlan, normalizeEmail, toAdminUser } from '../adminRules.js';

const router = Router();
const actorLimit = (name, max) => rateLimit({ windowMs: 60_000, max, name, keyFn: (req) => req.actor?.id });

function fail(res, status, message) {
    return res.status(status).json({ status: 'error', message });
}

// Tìm người dùng theo email (khớp chính xác): GET /admin/users?email=...
router.get('/users', requireAdmin, actorLimit('admin-users', 30), async (req, res) => {
    const email = normalizeEmail(req.query.email);
    if (!email) return fail(res, 400, 'Email không hợp lệ');

    const snap = await getDb().collection('users').where('email', '==', email).limit(5).get();
    res.status(200).json({ status: 'success', users: snap.docs.map((d) => toAdminUser(d.id, d.data())) });
});

// Đổi gói: PATCH /admin/users/:uid/plan { plan: 'free' | 'pro' }
const planSchema = z.object({ plan: z.string() }).strict();
const uidPattern = /^[A-Za-z0-9_-]{1,128}$/;

router.patch('/users/:uid/plan', requireAdmin, actorLimit('admin-plan', 30), async (req, res) => {
    const parsed = planSchema.safeParse(req.body);
    if (!parsed.success || !isValidPlan(parsed.data.plan)) {
        return fail(res, 400, `Gói không hợp lệ. Chọn một trong: ${PLAN_NAMES.join(', ')}`);
    }
    const { uid } = req.params;
    if (!uidPattern.test(uid)) return fail(res, 400, 'Mã người dùng không hợp lệ');

    const ref = getDb().collection('users').doc(uid);
    const snap = await ref.get();
    if (!snap.exists) return fail(res, 404, 'Không tìm thấy người dùng');

    const from = toAdminUser(uid, snap.data()).plan;
    const to = parsed.data.plan;
    await ref.update({ plan: to, updatedAt: FieldValue.serverTimestamp() });
    await getDb().collection('adminAudit').add({
        at: FieldValue.serverTimestamp(),
        adminUid: req.actor.id,
        action: 'set-plan',
        targetUid: uid,
        from,
        to
    });

    const fresh = await ref.get();
    res.status(200).json({ status: 'success', user: toAdminUser(uid, fresh.data()) });
});

export default router;

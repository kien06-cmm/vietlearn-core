// Chức năng: API chủ đề (Question Bank: Môn -> Chương -> Chủ đề). Mỗi câu hỏi bắt buộc thuộc một chủ đề.
import { Router } from 'express';
import { z } from 'zod';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../firebase.js';
import { requireRole } from '../middleware/permissions.js';
import { rateLimit } from '../middleware/rateLimit.js';

const router = Router();
const userOnly = requireRole(['user']);
const col = () => getDb().collection('topics');

const MAX_TOPICS = 300;

const createSchema = z
    .object({
        subject: z.string().trim().min(1).max(60),
        chapter: z.string().trim().min(1).max(80),
        name: z.string().trim().min(1).max(80)
    })
    .strict();

const toPublic = (id, d) => ({ id, subject: d.subject, chapter: d.chapter, name: d.name });
const sameKey = (d) => [d.subject, d.chapter, d.name].map((s) => s.trim().toLowerCase()).join('|');

// Danh sách chủ đề của tôi, sắp theo Môn -> Chương -> Chủ đề
router.get('/', userOnly, async (req, res) => {
    const snap = await col().where('ownerId', '==', req.actor.id).limit(MAX_TOPICS).get();
    const cmp = (a, b) => a.localeCompare(b, 'vi');
    const topics = snap.docs
        .map((d) => toPublic(d.id, d.data()))
        .sort((a, b) => cmp(a.subject, b.subject) || cmp(a.chapter, b.chapter) || cmp(a.name, b.name));
    res.status(200).json({ status: 'success', topics });
});

// Tạo chủ đề. Nếu đã có chủ đề y hệt (không phân biệt hoa thường) thì trả lại chủ đề cũ.
router.post('/', rateLimit({ windowMs: 60_000, max: 30, name: 'topics-create' }), userOnly, async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ status: 'error', message: 'Môn, chương, tên chủ đề không hợp lệ' });
    }

    const snap = await col().where('ownerId', '==', req.actor.id).limit(MAX_TOPICS).get();
    const wanted = sameKey(parsed.data);
    const found = snap.docs.find((d) => sameKey(d.data()) === wanted);
    if (found) return res.status(200).json({ status: 'success', topic: toPublic(found.id, found.data()) });

    if (snap.size >= MAX_TOPICS) {
        return res.status(403).json({ status: 'error', message: 'Đã đạt giới hạn số chủ đề', code: 'quota-topics' });
    }

    const ref = col().doc();
    await ref.set({
        ownerId: req.actor.id,
        ...parsed.data,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
    });
    res.status(201).json({ status: 'success', topic: toPublic(ref.id, parsed.data) });
});

export default router;

// Chức năng: API tài liệu - tạo + cấp link upload, xác nhận upload, danh sách, sửa, xóa, hạn mức.
import { Router } from 'express';
import { z } from 'zod';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb } from '../firebase.js';
import { createUploadUrl, getFileSize, readFileHead, removeFiles } from '../storage.js';
import { requireRole, requireOwner } from '../middleware/permissions.js';
import { rateLimit } from '../middleware/rateLimit.js';
import { getPlan } from '../config/plans.js';
import { wakeWorker } from '../worker/index.js';

const router = Router();

const TYPES = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'text/plain': 'txt'
};
const UPLOAD_URL_TTL_SECONDS = 2 * 60 * 60;

const col = () => getDb().collection('documents');

function fail(res, status, message, code) {
    return res.status(status).json({ status: 'error', message, ...(code ? { code } : {}) });
}

function iso(ts) {
    return ts?.toDate ? ts.toDate().toISOString() : null;
}

function toPublic(id, d) {
    return {
        id,
        name: d.name,
        mimeType: d.mimeType,
        sizeBytes: d.sizeBytes,
        status: d.status,
        pageCount: d.pageCount ?? null,
        progress: d.progress || null,
        folder: d.folder || '',
        tags: d.tags || [],
        pinned: !!d.pinned,
        error: d.error || null,
        createdAt: iso(d.createdAt),
        updatedAt: iso(d.updatedAt)
    };
}

async function countOwned(uid) {
    const snap = await col().where('ownerId', '==', uid).count().get();
    return snap.data().count;
}

// Phân quyền
const userOnly = requireRole(['user']);

async function docOwner(req) {
    const snap = await col().doc(req.params.id).get();
    req.docSnap = snap.exists ? snap : null;
    return req.docSnap ? req.docSnap.data().ownerId : null;
}
const ownerOnly = requireOwner(docOwner);

// Kiểm tra nội dung file theo định dạng
function looksValid(ext, head) {
    if (ext === 'pdf') return head.subarray(0, 5).toString('latin1') === '%PDF-';
    if (ext === 'docx') return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
    return head.length > 0 && !head.includes(0);
}

// Schema
const createSchema = z
    .object({
        name: z.string().trim().min(1).max(200),
        mimeType: z.enum(Object.keys(TYPES)),
        sizeBytes: z.number().int().positive()
    })
    .strict();

const updateSchema = z
    .object({
        name: z.string().trim().min(1).max(200).optional(),
        folder: z.string().trim().max(60).optional(),
        tags: z.array(z.string().trim().min(1).max(30)).max(10).optional(),
        pinned: z.boolean().optional()
    })
    .strict()
    .refine((v) => Object.keys(v).length > 0);

const listSchema = z.object({
    folder: z.string().max(60).optional(),
    tag: z.string().max(30).optional(),
    q: z.string().max(100).optional(),
    pinned: z.enum(['true']).optional()
});

const createLimiter = rateLimit({ windowMs: 60_000, max: 20, name: 'documents-create' });

// Hạn mức của người dùng
router.get('/quota', userOnly, async (req, res) => {
    const plan = getPlan(req.profile.plan);
    const usedDocuments = await countOwned(req.actor.id);
    res.status(200).json({
        status: 'success',
        quota: { plan: req.profile.plan, usedDocuments, ...plan }
    });
});

// Danh sách (lọc theo thư mục, tag, tên, ghim)
router.get('/', userOnly, async (req, res) => {
    const parsed = listSchema.safeParse(req.query);
    if (!parsed.success) return fail(res, 400, 'Bộ lọc không hợp lệ');
    const { folder, tag, q, pinned } = parsed.data;

    const snap = await col().where('ownerId', '==', req.actor.id).limit(200).get();
    let items = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    if (folder !== undefined) items = items.filter((d) => (d.folder || '') === folder);
    if (tag) items = items.filter((d) => (d.tags || []).includes(tag));
    if (pinned) items = items.filter((d) => d.pinned);
    if (q) {
        const needle = q.toLowerCase();
        items = items.filter((d) => d.name.toLowerCase().includes(needle));
    }

    items.sort((a, b) => {
        if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
        return (b.createdAt?.toMillis?.() ?? 0) - (a.createdAt?.toMillis?.() ?? 0);
    });

    res.status(200).json({ status: 'success', documents: items.map((d) => toPublic(d.id, d)) });
});

// Tạo tài liệu + link upload trực tiếp lên Storage
router.post('/', createLimiter, userOnly, async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'Dữ liệu không hợp lệ');

    const { name, mimeType, sizeBytes } = parsed.data;
    const ext = TYPES[mimeType];
    if (!name.toLowerCase().endsWith(`.${ext}`)) {
        return fail(res, 400, 'Đuôi file không khớp với loại file');
    }

    const plan = getPlan(req.profile.plan);
    if (sizeBytes > plan.maxFileBytes) {
        return fail(res, 413, `File quá lớn (tối đa ${plan.maxFileBytes / 1048576} MB)`, 'file-too-large');
    }

    const ownerId = req.actor.id;
    if ((await countOwned(ownerId)) >= plan.maxDocuments) {
        return fail(res, 403, 'Đã đạt giới hạn số tài liệu của gói', 'quota-documents');
    }

    const ref = col().doc();
    const storagePath = `${ownerId}/${ref.id}/original.${ext}`;
    const url = await createUploadUrl(storagePath);

    await ref.set({
        ownerId,
        name,
        mimeType,
        ext,
        sizeBytes,
        storagePath,
        status: 'uploading',
        pageCount: null,
        folder: '',
        tags: [],
        pinned: false,
        error: null,
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
    });

    const fresh = await ref.get();
    res.status(201).json({
        status: 'success',
        document: toPublic(ref.id, fresh.data()),
        upload: {
            url,
            method: 'PUT',
            headers: { 'Content-Type': mimeType },
            expiresInSeconds: UPLOAD_URL_TTL_SECONDS
        }
    });
});

// Xác nhận đã upload: kiểm tra file thật, rồi đưa vào hàng đợi xử lý
router.post('/:id/complete', ownerOnly, async (req, res) => {
    if (!req.docSnap) return fail(res, 404, 'Không tìm thấy tài liệu');

    const ref = req.docSnap.ref;
    const d = req.docSnap.data();
    if (d.status !== 'uploading') return fail(res, 409, 'Tài liệu đã được xác nhận trước đó');

    const size = await getFileSize(d.storagePath);
    if (size === null) return fail(res, 400, 'Chưa thấy file đã tải lên', 'file-missing');

    const reject = async (status, message, code) => {
        await removeFiles([d.storagePath]).catch(() => {});
        await ref.delete();
        return fail(res, status, message, code);
    };

    const plan = getPlan(req.profile.plan);
    if (size === 0) return reject(400, 'File rỗng', 'file-empty');
    if (size > plan.maxFileBytes) return reject(413, 'File quá lớn', 'file-too-large');

    const head = await readFileHead(d.storagePath, 4096);
    if (!looksValid(d.ext, head)) return reject(400, 'Nội dung file không đúng định dạng', 'file-invalid');

    // Transaction: nếu 2 request /complete đến cùng lúc, chỉ một request tạo được job
    const db = getDb();
    const jobRef = db.collection('jobs').doc();
    const claimed = await db.runTransaction(async (tx) => {
        const cur = await tx.get(ref);
        if (!cur.exists || cur.data().status !== 'uploading') return false;
        tx.update(ref, {
            status: 'queued',
            sizeBytes: size,
            progress: { done: 0, total: null },
            error: null,
            updatedAt: FieldValue.serverTimestamp()
        });
        tx.set(jobRef, {
            type: 'extract_document',
            ownerId: d.ownerId,
            documentId: ref.id,
            status: 'queued',
            attempts: 0,
            maxAttempts: 3,
            progress: { done: 0, total: null },
            error: null,
            deadLetter: false,
            runAfter: FieldValue.serverTimestamp(),
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp()
        });
        return true;
    });
    if (!claimed) return fail(res, 409, 'Tài liệu đã được xác nhận trước đó');

    wakeWorker(); // nếu worker chạy cùng tiến trình với API thì xử lý ngay

    const fresh = await ref.get();
    res.status(202).json({ status: 'success', document: toPublic(ref.id, fresh.data()), jobId: jobRef.id });
});

// Chi tiết một tài liệu
router.get('/:id', ownerOnly, (req, res) => {
    if (!req.docSnap) return fail(res, 404, 'Không tìm thấy tài liệu');
    res.status(200).json({ status: 'success', document: toPublic(req.docSnap.id, req.docSnap.data()) });
});

// Sửa tên / thư mục / tag / ghim
router.patch('/:id', ownerOnly, async (req, res) => {
    if (!req.docSnap) return fail(res, 404, 'Không tìm thấy tài liệu');

    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'Dữ liệu không hợp lệ');

    const update = { ...parsed.data, updatedAt: FieldValue.serverTimestamp() };
    if (update.tags) update.tags = [...new Set(update.tags)];

    await req.docSnap.ref.update(update);
    const fresh = await req.docSnap.ref.get();
    res.status(200).json({ status: 'success', document: toPublic(fresh.id, fresh.data()) });
});

// Xóa tài liệu: file gốc, chunk, job liên quan
router.delete('/:id', ownerOnly, async (req, res) => {
    if (!req.docSnap) return fail(res, 404, 'Không tìm thấy tài liệu');

    const ref = req.docSnap.ref;
    const { storagePath } = req.docSnap.data();
    const db = getDb();

    await removeFiles([storagePath]);
    const jobs = await db.collection('jobs').where('documentId', '==', ref.id).get();
    await Promise.all(jobs.docs.map((j) => j.ref.delete()));
    await db.recursiveDelete(ref);

    res.status(200).json({ status: 'success', message: 'Đã xóa tài liệu' });
});

export default router;

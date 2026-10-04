// Chức năng: server API chính (Express) - health check, hồ sơ người dùng /me (xem, sửa, xóa mềm), ghi sự kiện analytics /events.
import express from 'express';
import cors from 'cors';
import { z } from 'zod';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb, getProjectId } from './firebase.js';
import { requireAuth, optionalAuth } from './middleware/auth.js';
import { rateLimit } from './middleware/rateLimit.js';
import { requestLogger } from './middleware/requestLogger.js';

const app = express();
const port = process.env.PORT || 3000;

// Render đứng sau proxy: cần để req.ip là IP thật của người dùng (phục vụ rate limit)
app.set('trust proxy', 1);

// CORS_ORIGIN: domain frontend, ngăn cách bằng dấu phẩy. Để trống = cho phép tất cả.
const origins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
    : true;

app.use(cors({ origin: origins }));
app.use(express.json({ limit: '10kb' }));
app.use(requestLogger);

// Giới hạn chung cho toàn API: 120 request / phút / IP
app.use(rateLimit({ windowMs: 60_000, max: 120, name: 'global' }));

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'success',
        message: 'Hệ thống Backend VietLearn đang hoạt động!'
    });
});

// Kiểm tra đọc/ghi Firestore
app.get('/health/db', async (req, res) => {
    try {
        const db = getDb();
        const ref = db.collection('_health').doc('ping');
        await ref.set({ checkedAt: new Date().toISOString() });
        const snap = await ref.get();
        res.status(200).json({
            status: 'success',
            message: 'Backend đọc/ghi được Firestore',
            projectId: getProjectId(),
            data: snap.data()
        });
    } catch (err) {
        console.error('Lỗi /health/db:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ---------------------------------------------------------------------------
// Hồ sơ người dùng: users/{uid}
// ---------------------------------------------------------------------------

// Chuyển document Firestore thành object trả về cho client
function toPublicUser(uid, data, emailVerified) {
    return {
        uid,
        email: data.email,
        emailVerified: !!emailVerified,
        displayName: data.displayName,
        plan: data.plan,
        isAdmin: data.isAdmin,
        settings: data.settings || {}
    };
}

// Xem hồ sơ. Lần đầu gọi sẽ tạo users/{uid}.
app.get('/me', requireAuth, async (req, res) => {
    const { uid, email, email_verified: emailVerified } = req.user;
    const ref = getDb().collection('users').doc(uid);
    let snap = await ref.get();

    if (!snap.exists) {
        await ref.set({
            email: email || null,
            displayName: email ? email.split('@')[0] : '',
            plan: 'free',
            isAdmin: false,
            settings: {},
            createdAt: FieldValue.serverTimestamp(),
            updatedAt: FieldValue.serverTimestamp(),
            deletedAt: null
        });
        snap = await ref.get();
    }

    const data = snap.data();
    if (data.deletedAt) {
        return res.status(403).json({ status: 'error', message: 'Tài khoản đã bị xóa' });
    }

    res.status(200).json({ status: 'success', user: toPublicUser(uid, data, emailVerified) });
});

// Dữ liệu cho phép người dùng tự sửa. plan/isAdmin KHÔNG nằm ở đây (chỉ admin đổi).
const updateMeSchema = z
    .object({
        displayName: z.string().trim().min(1).max(50).optional(),
        settings: z
            .object({
                darkMode: z.boolean().optional(),
                fontSize: z.enum(['sm', 'md', 'lg']).optional()
            })
            .strict()
            .optional()
    })
    .strict();

// Sửa tên hiển thị / giao diện
app.patch('/me', requireAuth, async (req, res) => {
    const parsed = updateMeSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ status: 'error', message: 'Dữ liệu không hợp lệ' });
    }

    const { uid, email_verified: emailVerified } = req.user;
    const ref = getDb().collection('users').doc(uid);
    const snap = await ref.get();

    if (!snap.exists) {
        return res.status(404).json({ status: 'error', message: 'Chưa có hồ sơ. Hãy gọi GET /me trước.' });
    }
    if (snap.data().deletedAt) {
        return res.status(403).json({ status: 'error', message: 'Tài khoản đã bị xóa' });
    }

    // Dùng đường dẫn "settings.xxx" để chỉ ghi đúng trường được gửi, không đè cả map settings
    const update = { updatedAt: FieldValue.serverTimestamp() };
    const { displayName, settings } = parsed.data;
    if (displayName !== undefined) update.displayName = displayName;
    if (settings) {
        for (const [key, value] of Object.entries(settings)) {
            update[`settings.${key}`] = value;
        }
    }

    await ref.update(update);
    const fresh = await ref.get();
    res.status(200).json({ status: 'success', user: toPublicUser(uid, fresh.data(), emailVerified) });
});

// Xóa tài khoản (xóa mềm): chỉ đánh dấu deletedAt, không xóa dữ liệu thật
app.delete('/me', requireAuth, async (req, res) => {
    const ref = getDb().collection('users').doc(req.user.uid);
    const snap = await ref.get();

    if (!snap.exists) {
        return res.status(404).json({ status: 'error', message: 'Không tìm thấy hồ sơ' });
    }

    await ref.update({
        deletedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp()
    });
    res.status(200).json({ status: 'success', message: 'Đã xóa tài khoản' });
});

// ---------------------------------------------------------------------------
// Analytics: analyticsEvents/{eventId}  (Phase 1 chỉ có 'visit' và 'register')
// ---------------------------------------------------------------------------
const eventSchema = z.object({
    type: z.enum(['visit', 'register']),
    // meta: tối đa 10 khóa, giá trị là chuỗi ngắn (vd: { path: '/', source: 'direct' })
    meta: z
        .record(z.string().max(40), z.string().max(200))
        .refine((m) => Object.keys(m).length <= 10, 'meta tối đa 10 khóa')
        .optional()
});

// Giới hạn riêng chặt hơn: 30 sự kiện / phút / IP để không bị spam làm đầy Firestore
const eventsLimiter = rateLimit({ windowMs: 60_000, max: 30, name: 'events' });

app.post('/events', eventsLimiter, optionalAuth, async (req, res) => {
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) {
        return res.status(400).json({ status: 'error', message: 'Sự kiện không hợp lệ' });
    }

    const { type, meta } = parsed.data;
    await getDb().collection('analyticsEvents').add({
        type,
        uid: req.user?.uid || null,
        at: FieldValue.serverTimestamp(),
        meta: meta || {}
    });

    res.status(202).json({ status: 'success' });
});

// ---------------------------------------------------------------------------
// Xử lý lỗi
// ---------------------------------------------------------------------------

// Đường dẫn không tồn tại
app.use((req, res) => {
    res.status(404).json({ status: 'error', message: 'Không tìm thấy đường dẫn' });
});

// Lỗi không bắt được (Express 5 tự chuyển lỗi của async handler vào đây)
app.use((err, req, res, next) => {
    // Body JSON hỏng hoặc quá lớn: lỗi do client, không phải lỗi server
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
        return res.status(400).json({ status: 'error', message: 'Dữ liệu gửi lên không hợp lệ' });
    }
    console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', message: err.message }));
    res.status(500).json({ status: 'error', message: 'Lỗi máy chủ' });
});

app.listen(port, () => {
    console.log(`Backend Server đang chạy tại cổng ${port}`);
});

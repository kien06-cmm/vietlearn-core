// Chức năng: server API chính (Express) - health check, kiểm tra Firestore, hồ sơ người dùng /me.
import express from 'express';
import cors from 'cors';
import { FieldValue } from 'firebase-admin/firestore';
import { getDb, getProjectId } from './firebase.js';
import { requireAuth } from './middleware/auth.js';

const app = express();
const port = process.env.PORT || 3000;

// CORS_ORIGIN: domain frontend, ngăn cách bằng dấu phẩy. Để trống = cho phép tất cả.
const origins = process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim())
    : true;

app.use(cors({ origin: origins }));
app.use(express.json());

// Health check
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

// Hồ sơ người dùng hiện tại. Lần đầu gọi sẽ tạo users/{uid}.
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

    res.status(200).json({
        status: 'success',
        user: {
            uid,
            email: data.email,
            emailVerified: !!emailVerified,
            displayName: data.displayName,
            plan: data.plan,
            isAdmin: data.isAdmin
        }
    });
});

// Lỗi không bắt được
app.use((err, req, res, next) => {
    console.error('Lỗi server:', err.message);
    res.status(500).json({ status: 'error', message: 'Lỗi máy chủ' });
});

app.listen(port, () => {
    console.log(`Backend Server đang chạy tại cổng ${port}`);
});

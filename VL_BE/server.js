import express from 'express';
import cors from 'cors';
import { getDb } from './firebase.js';

const app = express();
const port = process.env.PORT || 3000;

// Cấp phép cho Frontend gọi API không bị chặn
app.use(cors());
app.use(express.json());

// API thử nghiệm (Health Check)
app.get('/health', (req, res) => {
    res.status(200).json({ 
        status: 'success', 
        message: 'Hệ thống Backend VietLearn đang hoạt động!' 
    });
});

// Kiểm tra backend ghi và đọc được Firestore
app.get('/health/db', async (req, res) => {
    try {
        const db = getDb();
        const ref = db.collection('_health').doc('ping');
        await ref.set({ checkedAt: new Date().toISOString() });
        const snap = await ref.get();
        res.status(200).json({
            status: 'success',
            message: 'Backend đọc/ghi được Firestore',
            data: snap.data()
        });
    } catch (err) {
        console.error('Lỗi /health/db:', err.message);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.listen(port, () => {
    console.log(`Backend Server đang chạy tại cổng ${port}`);
});

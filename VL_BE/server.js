import express from 'express';
import cors from 'cors';

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

app.listen(port, () => {
    console.log(`Backend Server đang chạy tại cổng ${port}`);
});
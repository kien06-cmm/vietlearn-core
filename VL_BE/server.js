import express from 'express';

const app = express();
const port = process.env.PORT || 3000;

// Middleware để parse dữ liệu dạng JSON
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
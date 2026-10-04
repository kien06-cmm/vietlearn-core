// Chức năng: ghi log có cấu trúc (mỗi request một dòng JSON) để dễ lọc/tìm lỗi trên Render.

export function requestLogger(req, res, next) {
    const start = Date.now();

    res.on('finish', () => {
        // Chỉ log đường dẫn (không log query string, không log token)
        const entry = {
            time: new Date().toISOString(),
            method: req.method,
            path: req.path,
            status: res.statusCode,
            ms: Date.now() - start,
            uid: req.user?.uid || null
        };
        console.log(JSON.stringify(entry));
    });

    next();
}

// Chức năng: theo dõi lỗi bằng Sentry. Chỉ bật khi có biến môi trường SENTRY_DSN; không có thì bỏ qua êm.
let Sentry = null;

export async function initMonitoring() {
    const dsn = process.env.SENTRY_DSN;
    if (!dsn) return;

    try {
        Sentry = await import('@sentry/node');
        Sentry.init({
            dsn,
            environment: process.env.APP_ENV || process.env.NODE_ENV || 'development',
            sendDefaultPii: false // không gửi IP/email lên Sentry
        });
        console.log(JSON.stringify({ time: new Date().toISOString(), level: 'info', message: 'Sentry đã bật' }));
    } catch (err) {
        // Chưa cài @sentry/node hoặc DSN sai: server vẫn chạy bình thường
        Sentry = null;
        console.error(JSON.stringify({ time: new Date().toISOString(), level: 'error', message: `Không bật được Sentry: ${err.message}` }));
    }
}

// Gửi lỗi lên Sentry (nếu đang bật). ctx chỉ nên chứa thông tin không nhạy cảm (path, uid).
export function captureError(err, ctx = {}) {
    if (!Sentry) return;
    Sentry.captureException(err, { extra: ctx });
}

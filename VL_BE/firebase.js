// Khởi tạo Firebase Admin SDK. Khóa service account chỉ lấy từ biến môi trường, không đưa vào code.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

let db = null;
let projectId = null;

export function getProjectId() {
    return projectId;
}

export function getDb() {
    if (db) return db;

    const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON || process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw) {
        throw new Error('Thiếu biến môi trường FIREBASE_SERVICE_ACCOUNT_JSON');
    }

    let serviceAccount;
    try {
        serviceAccount = JSON.parse(raw);
    } catch {
        throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON không phải JSON hợp lệ');
    }

    // Khi dán vào biến môi trường, xuống dòng trong private_key có thể bị đổi thành "\n" dạng chữ
    if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    if (getApps().length === 0) {
        initializeApp({ credential: cert(serviceAccount) });
    }
    projectId = serviceAccount.project_id || null;
    db = getFirestore();
    return db;
}

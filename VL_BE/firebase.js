// Chức năng: kết nối Firebase Admin (Firestore + Auth), khóa lấy từ biến môi trường.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

let projectId = null;

export function getProjectId() {
    return projectId;
}

function init() {
    if (getApps().length > 0) return;

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

    // private_key dán vào biến môi trường có thể bị đổi xuống dòng thành chữ "\n"
    if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
    }

    initializeApp({ credential: cert(serviceAccount) });
    projectId = serviceAccount.project_id || null;
}

export function getDb() {
    init();
    return getFirestore();
}

export function getAdminAuth() {
    init();
    return getAuth();
}

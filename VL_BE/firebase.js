// Chức năng: kết nối Firebase Admin (Firestore + Auth + Storage), khóa lấy từ biến môi trường.
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getStorage } from 'firebase-admin/storage';

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

    // Bucket mặc định theo project; đặt FIREBASE_STORAGE_BUCKET nếu tên khác
    const storageBucket =
        process.env.FIREBASE_STORAGE_BUCKET || `${serviceAccount.project_id}.firebasestorage.app`;

    initializeApp({ credential: cert(serviceAccount), storageBucket });
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

export function getBucket() {
    init();
    return getStorage().bucket();
}

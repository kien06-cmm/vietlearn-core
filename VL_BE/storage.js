// Chức năng: lưu trữ file tài liệu trên Supabase Storage (bucket riêng tư, chỉ backend truy cập).
import { createClient } from '@supabase/supabase-js';

const BUCKET = process.env.SUPABASE_BUCKET || 'documents';
let client = null;

function getClient() {
    if (client) return client;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
        throw new Error('Thiếu biến môi trường SUPABASE_URL hoặc SUPABASE_SERVICE_ROLE_KEY');
    }
    client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    return client;
}

const bucket = () => getClient().storage.from(BUCKET);

function check(error) {
    if (error) throw new Error(error.message || 'Lỗi Supabase Storage');
}

// Link PUT để client tải file lên thẳng (hiệu lực 2 giờ)
export async function createUploadUrl(path) {
    const { data, error } = await bucket().createSignedUploadUrl(path);
    check(error);
    return data.signedUrl;
}

// Dung lượng file (byte). Trả về null nếu file chưa tồn tại.
export async function getFileSize(path) {
    const parts = path.split('/');
    const name = parts.pop();
    const { data, error } = await bucket().list(parts.join('/'), { limit: 100, search: name });
    check(error);
    const item = (data || []).find((f) => f.name === name);
    return item ? Number(item.metadata?.size ?? 0) : null;
}

// Đọc vài byte đầu của file để kiểm tra định dạng
export async function readFileHead(path, length) {
    const { data, error } = await bucket().createSignedUrl(path, 60);
    check(error);
    const res = await fetch(data.signedUrl, { headers: { Range: `bytes=0-${length - 1}` } });
    if (!res.ok) throw new Error(`Không đọc được file (${res.status})`);
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.subarray(0, length);
}

// Tải toàn bộ file về bộ nhớ (worker dùng để trích văn bản)
export async function downloadFile(path) {
    const { data, error } = await bucket().createSignedUrl(path, 300);
    check(error);
    const res = await fetch(data.signedUrl);
    if (!res.ok) throw new Error(`Không tải được file (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
}

// Link tạm (5 phút) để người dùng xem/tải file gốc
export async function createViewUrl(path) {
    const { data, error } = await bucket().createSignedUrl(path, 300);
    check(error);
    return data.signedUrl;
}

// Xóa file (bỏ qua file không tồn tại)
export async function removeFiles(paths) {
    const { error } = await bucket().remove(paths);
    check(error);
}

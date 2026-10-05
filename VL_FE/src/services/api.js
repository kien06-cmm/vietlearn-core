// Chức năng: các hàm gọi API backend trên Render (health, hồ sơ /me, tài liệu /documents, ghi sự kiện analytics).
const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://vietlearn-core.onrender.com'

// Gửi request tới backend. body (nếu có) được gửi dạng JSON.
async function request(path, { token, method = 'GET', body } = {}) {
  const headers = {}
  if (token) headers.Authorization = `Bearer ${token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    // Lấy thông báo tiếng Việt từ backend nếu có, kèm mã trạng thái để giao diện xử lý riêng từng trường hợp
    let data = null
    try {
      data = await res.json()
    } catch {
      // phản hồi không phải JSON
    }
    const err = new Error(data?.message || `Backend trả về lỗi ${res.status}`)
    err.status = res.status
    err.code = data?.code
    throw err
  }
  return res.json()
}

export function getHealth() {
  return request('/health')
}

export function getMe(token) {
  return request('/me', { token })
}

// Sửa hồ sơ: { displayName?, settings?: { darkMode?, fontSize? } }
export function updateMe(token, changes) {
  return request('/me', { token, method: 'PATCH', body: changes })
}

// Xóa tài khoản (xóa mềm)
export function deleteMe(token) {
  return request('/me', { token, method: 'DELETE' })
}

// ---------- Tài liệu (Phase 2) ----------

// Hạn mức theo gói: { plan, usedDocuments, maxFileBytes, maxDocuments, maxPages }
export function getQuota(token) {
  return request('/documents/quota', { token })
}

export function listDocuments(token) {
  return request('/documents', { token })
}

export function getDocument(token, id) {
  return request(`/documents/${id}`, { token })
}

// Tạo tài liệu + nhận link upload: { name, mimeType, sizeBytes } -> { document, upload: { url, headers } }
export function createDocument(token, data) {
  return request('/documents', { token, method: 'POST', body: data })
}

// Báo đã tải xong: backend kiểm tra file thật rồi đưa vào hàng đợi xử lý
export function completeDocument(token, id) {
  return request(`/documents/${id}/complete`, { token, method: 'POST' })
}

// Sửa: { name?, folder?, tags?, pinned? }
export function updateDocument(token, id, changes) {
  return request(`/documents/${id}`, { token, method: 'PATCH', body: changes })
}

export function deleteDocument(token, id) {
  return request(`/documents/${id}`, { token, method: 'DELETE' })
}

// Nội dung văn bản của một trang: { page: { number, text }, pageCount }
export function getDocumentPage(token, id, page) {
  return request(`/documents/${id}/pages/${page}`, { token })
}

// Tải file lên thẳng Storage bằng link PUT backend cấp (không qua backend). onProgress(percent) để hiện thanh tiến độ.
export function uploadToSignedUrl(url, file, mimeType, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', url)
    xhr.setRequestHeader('Content-Type', mimeType)
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error('Tải file lên thất bại. Vui lòng thử lại.'))
    xhr.onerror = () => reject(new Error('Lỗi mạng khi tải file lên. Kiểm tra kết nối rồi thử lại.'))
    xhr.send(file)
  })
}

// Ghi sự kiện analytics ('visit' | 'register'). Lỗi được bỏ qua để không ảnh hưởng người dùng.
export async function trackEvent(type, { token, meta } = {}) {
  try {
    await request('/events', { token, method: 'POST', body: { type, meta } })
  } catch {
    // analytics là phụ, không báo lỗi ra giao diện
  }
}

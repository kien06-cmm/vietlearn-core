// Chức năng: các hàm gọi API backend trên Render (health, hồ sơ /me, ghi sự kiện analytics).
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
  if (!res.ok) throw new Error(`Backend trả về lỗi ${res.status}`)
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

// Ghi sự kiện analytics ('visit' | 'register'). Lỗi được bỏ qua để không ảnh hưởng người dùng.
export async function trackEvent(type, { token, meta } = {}) {
  try {
    await request('/events', { token, method: 'POST', body: { type, meta } })
  } catch {
    // analytics là phụ, không báo lỗi ra giao diện
  }
}

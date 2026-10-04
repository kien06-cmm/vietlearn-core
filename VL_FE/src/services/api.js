// Chức năng: các hàm gọi API backend trên Render (health, hồ sơ /me kèm token).
const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://vietlearn-core.onrender.com'

async function request(path, token) {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  })
  if (!res.ok) throw new Error(`Backend trả về lỗi ${res.status}`)
  return res.json()
}

export function getHealth() {
  return request('/health')
}

export function getMe(token) {
  return request('/me', token)
}

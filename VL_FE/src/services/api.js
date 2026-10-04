// Gọi API backend trên Render. Địa chỉ lấy từ biến môi trường VITE_API_BASE_URL.
const BASE_URL = import.meta.env.VITE_API_BASE_URL || 'https://vietlearn-core.onrender.com'

export async function getHealth() {
  const res = await fetch(`${BASE_URL}/health`)
  if (!res.ok) throw new Error(`Backend trả về lỗi ${res.status}`)
  return res.json()
}

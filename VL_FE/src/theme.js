// Chức năng: áp giao diện (chế độ tối, cỡ chữ) lên toàn trang và nhớ lại trên máy để không bị nháy khi tải lại.
const KEY = 'vl_prefs'

function readSaved() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {}
  } catch {
    return {}
  }
}

// prefs: { darkMode?: boolean, fontSize?: 'sm' | 'md' | 'lg' }. Giá trị thiếu thì lấy bản đã nhớ,
// chưa có nữa thì theo hệ thống (tối/sáng) và cỡ chữ vừa.
export function applyPrefs(prefs = {}) {
  const saved = readSaved()
  const darkMode = prefs.darkMode ?? saved.darkMode
  const fontSize = prefs.fontSize ?? saved.fontSize

  const root = document.documentElement
  const isDark = darkMode ?? window.matchMedia('(prefers-color-scheme: dark)').matches
  root.dataset.theme = isDark ? 'dark' : 'light'
  root.dataset.font = fontSize ?? 'md'

  // Chỉ nhớ những giá trị người dùng đã chọn thật (chưa chọn thì vẫn theo hệ thống)
  try {
    localStorage.setItem(KEY, JSON.stringify({ darkMode, fontSize }))
  } catch {
    // trình duyệt chặn lưu trữ: bỏ qua
  }
}

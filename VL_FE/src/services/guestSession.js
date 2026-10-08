// Chức năng: phiên khách lưu trên máy (localStorage) để tải lại trang hoặc mất mạng vẫn vào lại đúng phòng với cùng danh tính (cùng bài đang làm dở).
const KEY = 'vl_guest_session'

// Trả { token, guest: { id, displayName, expiresAt } } nếu còn hạn, ngược lại null
export function loadGuest() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY))
    if (s?.token && s.guest?.expiresAt && Date.parse(s.guest.expiresAt) > Date.now()) return s
  } catch {
    // không đọc được: coi như chưa có
  }
  return null
}

export function saveGuest(session) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ token: session.token, guest: session.guest }))
  } catch {
    // trình duyệt chặn lưu: vẫn dùng được trong phiên này
  }
}

export function clearGuest() {
  try {
    localStorage.removeItem(KEY)
  } catch {
    // bỏ qua
  }
}

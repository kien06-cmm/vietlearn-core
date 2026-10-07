// Chức năng: tính thời điểm AI credits được làm mới. Credits tính theo THÁNG (giờ UTC) nên reset lúc 0h UTC ngày 1 tháng sau
// (= 7h sáng ngày 1 theo giờ Việt Nam). Hiển thị theo múi giờ của trình duyệt.

// period dạng "2026-10"; bỏ trống thì dùng tháng hiện tại (UTC)
export function nextResetDate(period) {
  const now = new Date()
  const [y, m] = /^\d{4}-\d{2}$/.test(String(period))
    ? String(period).split('-').map(Number)
    : [now.getUTCFullYear(), now.getUTCMonth() + 1]
  return new Date(Date.UTC(y, m, 1)) // m (1-12) dùng làm chỉ số tháng 0-11 = tháng kế tiếp; tháng 12 tự sang tháng 1 năm sau
}

export function nextResetText(period) {
  return nextResetDate(period).toLocaleString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

// Thông báo lỗi cho người dùng: hết credits thì kèm ngày dùng lại
export function creditErrorText(err) {
  return err?.code === 'quota-credits' ? `${err.message}. Bạn dùng lại được từ ${nextResetText()}.` : err.message
}

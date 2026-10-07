// Chức năng: tính và hiển thị thời điểm AI credits được làm mới.
// Backend trả sẵn mốc `resetsAt` (ISO); giao diện chỉ đếm ngược tới mốc đó nên khi backend đổi chu kỳ
// (tháng, tuần, hay vài giờ) thì giao diện không phải sửa gì. Hiện tại credits tính theo THÁNG (giờ UTC):
// reset 0h UTC ngày 1 tháng sau = 7h sáng ngày 1 theo giờ Việt Nam.

// Mốc reset: ưu tiên `resetsAt` từ backend; chỉ có `period` ("2026-10") thì tự suy ra cuối tháng đó
export function resetDate({ resetsAt, period } = {}) {
  if (resetsAt) {
    const d = new Date(resetsAt)
    if (!Number.isNaN(d.getTime())) return d
  }
  const now = new Date()
  const [y, m] = /^\d{4}-\d{2}$/.test(String(period))
    ? String(period).split('-').map(Number)
    : [now.getUTCFullYear(), now.getUTCMonth() + 1]
  return new Date(Date.UTC(y, m, 1)) // m (1-12) dùng làm chỉ số tháng 0-11 = tháng kế tiếp; tháng 12 tự sang tháng 1 năm sau
}

// Ngày giờ cụ thể theo múi giờ của trình duyệt, ví dụ "07:00 01/11/2026"
export function formatResetAt(date) {
  return date.toLocaleString('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  })
}

// Giữ tên cũ cho các màn hình khác còn dùng
export function nextResetText(period) {
  return formatResetAt(resetDate({ period }))
}

// Đếm ngược dạng người đọc được, tự đổi đơn vị theo độ dài:
// 3 ngày 4 giờ | 6 giờ 52 phút | 42 phút 10 giây | 8 giây
export function formatCountdown(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60

  if (days > 0) return hours > 0 ? `${days} ngày ${hours} giờ` : `${days} ngày`
  if (hours > 0) return minutes > 0 ? `${hours} giờ ${minutes} phút` : `${hours} giờ`
  if (minutes > 0) return `${minutes} phút ${String(seconds).padStart(2, '0')} giây`
  return `${seconds} giây`
}

// Bản gọn cho chip trên thanh đầu trang: 3n 4g | 6g 52p | 42p | 8s
export function formatCountdownShort(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  if (days > 0) return `${days}n ${hours}g`
  if (hours > 0) return `${hours}g ${minutes}p`
  if (minutes > 0) return `${minutes}p`
  return `${total}s`
}

// Thông báo lỗi cho người dùng: hết credits thì kèm thời gian chờ để dùng lại
export function creditErrorText(err) {
  if (err?.code !== 'quota-credits') return err.message
  const at = resetDate({ resetsAt: err.resetsAt })
  const wait = formatCountdown(at.getTime() - Date.now())
  return `${err.message}. Credits làm mới sau ${wait} (lúc ${formatResetAt(at)}).`
}

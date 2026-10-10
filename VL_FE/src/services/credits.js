// Chức năng: tính và hiển thị thời điểm AI credits được làm mới.
// Backend trả sẵn mốc `resetsAt` (ISO) của hạn mức đang chặn (ngày hoặc tuần); giao diện chỉ đếm ngược tới mốc đó
// nên khi backend đổi chu kỳ thì giao diện không phải sửa gì. Hiển thị theo múi giờ của trình duyệt.

// Mốc reset: ưu tiên `resetsAt` từ backend. Thiếu thì suy ra từ `period`: ngày "2026-10-07" -> 0h giờ Việt Nam ngày hôm sau;
// tháng "2026-10" (bản backend cũ) -> đầu tháng sau.
export function resetDate({ resetsAt, period } = {}) {
  if (resetsAt) {
    const d = new Date(resetsAt)
    if (!Number.isNaN(d.getTime())) return d
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(period))
  if (day) return new Date(Date.UTC(+day[1], +day[2] - 1, +day[3] + 1) - 7 * 3600_000)
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

// ---------- AI tạm nghỉ (Gemini báo quá tải / hết hạn mức, backend trả 429 mã 'ai-unavailable') ----------

export const DEFAULT_AI_PAUSE_MS = 60_000 // khớp mức nghỉ mặc định của backend khi Gemini không gợi ý

export const isAiPauseError = (err) => err?.status === 429 && err?.code === 'ai-unavailable'

// Mốc AI dùng lại được (Date) nếu lỗi là AI quá tải, ngược lại trả null
export function aiPauseUntil(err) {
  return isAiPauseError(err) ? new Date(Date.now() + (err.retryAfterMs ?? DEFAULT_AI_PAUSE_MS)) : null
}

// Thông báo khi gọi AI lỗi: giải thích rõ lý do, nói credits không bị trừ, và bảo khi nào thử lại được
export function aiErrorText(err) {
  if (err?.code === 'quota-credits') return creditErrorText(err)
  if (!isAiPauseError(err)) return err?.message || 'Có lỗi xảy ra, vui lòng thử lại.'
  const wait = err.retryAfterMs ? ` Thử lại sau khoảng ${formatCountdown(err.retryAfterMs)}.` : ' Vui lòng thử lại sau ít phút.'
  const head = err.reason === 'quota-daily' ? 'AI đã hết hạn mức hôm nay.' : 'AI đang quá tải.'
  return `${head} Credits của bạn không bị trừ.${wait}`
}

// Lý do job đang chờ thử lại, theo mã lỗi backend ghi trên job (null = không phải lỗi do AI quá tải)
const JOB_WAIT_REASON = {
  'ai-rate-limit': 'AI đang quá tải',
  'ai-cooldown': 'AI đang tạm nghỉ do quá tải',
  'ai-quota-daily': 'AI đã hết hạn mức hôm nay',
}

export const jobWaitReason = (code) => JOB_WAIT_REASON[code] ?? null

// Thông báo khi job tạo câu hỏi thất bại hẳn. Lỗi AI thì nói rõ nguyên nhân (không hiện thông báo kỹ thuật như "AI lỗi 429"), lỗi khác giữ nguyên thông điệp từ backend.
export function jobFailText(job) {
  if (job.errorCode === 'ai-quota-daily') return 'AI đã hết hạn mức hôm nay, hãy thử lại sau.'
  if (job.errorCode === 'ai-rate-limit' || job.errorCode === 'ai-cooldown') {
    return 'AI quá tải trong nhiều lần thử liên tiếp nên chưa tạo được câu hỏi. Hãy thử lại sau ít phút.'
  }
  return job.error || 'Tạo câu hỏi thất bại.'
}

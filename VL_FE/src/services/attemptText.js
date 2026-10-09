// Chức năng: hàm nhỏ dùng chung cho màn làm bài và màn kết quả (đồng hồ đếm ngược, nhãn trạng thái, kiểm tra đã trả lời).
export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'

// Câu đã có trả lời: không phải rỗng, không phải mảng rỗng
export const isAnswered = (v) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && v.length === 0)

// 125000 ms -> "02:05"; từ 1 giờ trở lên -> "1:02:05"
export function formatClock(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  const p = (n) => String(n).padStart(2, '0')
  return h ? `${h}:${p(m)}:${p(sec)}` : `${p(m)}:${p(sec)}`
}

export const STATUS_LABELS = {
  correct: 'Đúng',
  wrong: 'Sai',
  unanswered: 'Bỏ qua',
  pending: 'Tự đối chiếu',
}

export const tfText = (v) => (v === true ? 'Đúng' : v === false ? 'Sai' : '')

export const CONFIDENCE_LEVELS = [
  { value: 'sure', label: 'Chắc chắn' },
  { value: 'unsure', label: 'Phân vân' },
  { value: 'guess', label: 'Đoán' },
]

export const CONFIDENCE_LABELS = Object.fromEntries(CONFIDENCE_LEVELS.map((c) => [c.value, c.label]))

export const timeText = (d) => d.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })

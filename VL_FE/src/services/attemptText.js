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

// Gợi ý kiểu sai (Phase 5). Backend phân loại theo luật cố định nên chỉ là gợi ý, không phải kết luận.
// label: nhãn ngắn trên huy hiệu; hint: lý do gợi ý + việc nên làm
export const ERROR_TYPES = [
  { value: 'misconception', label: 'Có thể hiểu nhầm', hint: 'Bạn chọn “Chắc chắn” nhưng sai. Nên xem lại cách hiểu khái niệm này.' },
  { value: 'knowledge', label: 'Có thể thiếu kiến thức', hint: 'Sai và không có dấu hiệu đoán hay làm vội. Nên ôn lại phần lý thuyết liên quan.' },
  { value: 'guess', label: 'Có thể do đoán', hint: 'Bạn đánh dấu “Đoán”. Câu này chưa nắm, nên học lại trước khi làm tiếp.' },
  { value: 'careless', label: 'Có thể do ẩu', hint: 'Bạn trả lời rất nhanh (dưới 3 giây). Thử đọc kỹ đề và các lựa chọn hơn.' },
  { value: 'changed', label: 'Có thể do đổi đáp án', hint: 'Bạn đã đổi đáp án rồi sai. Lần sau hãy tin vào cách làm đã cân nhắc kỹ.' },
  { value: 'timeout', label: 'Hết giờ', hint: 'Câu này còn bỏ trống khi hết giờ. Thử chia thời gian đều hơn giữa các câu.' },
]

export const ERROR_LABELS = Object.fromEntries(ERROR_TYPES.map((e) => [e.value, e.label]))

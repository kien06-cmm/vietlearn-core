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

// Gợi ý kiểu sai (Phase 5). Backend phân loại theo luật cố định dựa trên mức tự tin, thời gian làm, số lần đổi đáp án và lịch sử câu này, nên chỉ là gợi ý, không phải kết luận.
// Khi không có tín hiệu nào thì backend trả 'unknown' thay vì đoán. label: nhãn ngắn trên huy hiệu; hint: dấu hiệu dẫn đến gợi ý + việc nên làm
export const ERROR_TYPES = [
  { value: 'misconception', label: 'Có thể hiểu nhầm', hint: 'Bạn đã chọn “Chắc chắn” hoặc chọn lại đúng đáp án sai từng chọn, nên nhiều khả năng đang hiểu khác với đáp án đúng. Đọc phần giải thích và so với cách bạn nghĩ.' },
  { value: 'knowledge', label: 'Có thể chưa nắm kiến thức', hint: 'Bạn thấy phân vân, nghĩ khá lâu hoặc đã sai câu này nhiều lần. Nên ôn lại phần lý thuyết của chủ đề này.' },
  { value: 'guess', label: 'Có thể do đoán', hint: 'Bạn đánh dấu “Đoán”. Câu này chưa nắm, nên học lại trước khi làm tiếp.' },
  { value: 'careless', label: 'Có thể do ẩu', hint: 'Bạn trả lời nhanh hơn thời gian đọc đề thông thường. Thử đọc kỹ đề và từng lựa chọn trước khi trả lời.' },
  { value: 'changed', label: 'Có thể do lưỡng lự', hint: 'Bạn đổi đáp án nhiều lần trước khi nộp, dấu hiệu chưa chắc về khái niệm. Thử nêu lý do chọn đáp án thay vì đổi theo cảm giác.' },
  { value: 'timeout', label: 'Hết giờ', hint: 'Câu này còn bỏ trống khi hết giờ. Thử chia thời gian đều hơn giữa các câu.' },
  { value: 'unknown', label: 'Chưa rõ nguyên nhân', hint: 'Chưa đủ dữ liệu để gợi ý nguyên nhân. Lần sau hãy chọn mức tự tin (Chắc chắn / Phân vân / Đoán) để hệ thống gợi ý chính xác hơn.' },
]

export const ERROR_LABELS = Object.fromEntries(ERROR_TYPES.map((e) => [e.value, e.label]))

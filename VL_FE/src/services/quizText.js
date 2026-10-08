// Chức năng: văn bản mô tả cài đặt quiz (dùng chung cho danh sách và lịch sử version).
export function settingsText(s) {
  if (!s) return ''
  const time = s.timeLimitMinutes ? `${s.timeLimitMinutes} phút` : 'Không giới hạn thời gian'
  const attempts = s.maxAttempts ? `${s.maxAttempts} lần làm` : 'Không giới hạn lần làm'
  return `${time} · ${attempts}`
}

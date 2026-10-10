// Chức năng: hiển thị AI credits - thẻ đầy đủ (thanh còn lại, đếm ngược tới lúc làm mới, thông báo khi hết) và chip nhỏ trên thanh đầu trang.
import { useAiPause, useCountdown, useCredits } from '../hooks/useCredits.jsx'
import { formatCountdown, formatCountdownShort, formatResetAt, resetDate } from '../services/credits.js'
import Icon from './Icon.jsx'
import './AiPause.css'

const LOW_RATIO = 0.2 // còn dưới 20% thì đổi sang màu cảnh báo nhẹ

function useCreditState() {
  const { credits } = useCredits()
  const at = credits ? resetDate(credits) : null
  const left = useCountdown(at)
  if (!credits) return { credits: null }

  const empty = credits.remaining <= 0
  // Hạn mức đang chặn: tuần (nếu tuần chặt hơn) hoặc ngày. Tính tỉ lệ còn lại theo hạn mức đó.
  const limit = credits.window === 'week' && credits.week ? credits.week.limit : credits.limit
  const low = !empty && limit > 0 && credits.remaining / limit <= LOW_RATIO
  const ratio = limit > 0 ? Math.min(1, credits.remaining / limit) : 0
  return { credits, at, left, empty, low, ratio, limit }
}

// compact: dùng trong form tạo câu hỏi (bỏ phần tiêu đề lớn)
export default function CreditCard({ compact = false, note }) {
  const s = useCreditState()

  if (!s.credits) {
    return (
      <section className="credit-card" aria-busy="true">
        <span className="skeleton skeleton-line" />
        <span className="skeleton skeleton-bar" />
      </section>
    )
  }

  const { credits, at, left, empty, low, ratio, limit } = s
  const state = empty ? ' is-empty' : low ? ' is-low' : ''

  return (
    <section className={`credit-card${compact ? ' is-compact' : ''}${state}`} aria-live="polite">
      <div className="credit-head">
        <span className="credit-icon" aria-hidden="true">
          <Icon name={empty ? 'clock' : 'spark'} size={compact ? 18 : 20} />
        </span>
        <div className="credit-title">
          <p className="credit-label">{credits.window === 'week' ? 'AI credits còn lại trong tuần' : 'AI credits hôm nay'}</p>
          <p className="credit-num">
            <strong>{credits.remaining}</strong>
            <span>/{limit}</span>
          </p>
        </div>
        {note && <p className="credit-note">{note}</p>}
      </div>

      <div
        className="meter"
        role="meter"
        aria-label="AI credits còn lại"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={credits.remaining}
      >
        <span style={{ width: `${ratio * 100}%` }} />
      </div>

      {empty ? (
        <div className="credit-wait" role="status">
          <p className="credit-wait-title">
            {credits.window === 'week' ? 'Bạn đã dùng hết credits của tuần này.' : 'Bạn đã dùng hết credits hôm nay.'}
          </p>
          <p className="credit-wait-text">
            Dùng lại được sau <b className="count">{formatCountdown(left)}</b>
          </p>
          <p className="hint">Lúc {formatResetAt(at)}. Trong lúc chờ bạn vẫn đọc, ghim và duyệt câu hỏi bình thường.</p>
        </div>
      ) : (
        <p className="credit-reset">
          <Icon name="refresh" size={14} />
          {low ? 'Sắp hết. ' : ''}
          {credits.window === 'week' ? 'Hạn mức tuần làm mới sau ' : 'Làm mới sau '}
          {formatCountdown(left)}
        </p>
      )}

      {!compact && credits.week && (
        <p className="credit-week">
          Cả tuần: còn {credits.week.remaining}/{credits.week.limit}
        </p>
      )}
    </section>
  )
}

// Thông báo khi Gemini quá tải/hết hạn mức: AI tạm nghỉ, đếm ngược tới lúc dùng lại. Tự biến mất khi hết giờ nghỉ.
export function AiPauseNotice() {
  const { paused, left } = useAiPause()
  if (!paused) return null

  return (
    <div className="ai-pause" role="status">
      <Icon name="clock" size={18} />
      <div>
        <p>
          <strong>AI đang tạm nghỉ vì quá tải hoặc hết hạn mức.</strong> Dùng lại được sau{' '}
          <b className="count" aria-live="off">
            {formatCountdown(left)}
          </b>
          .
        </p>
        <p className="hint">Credits của bạn không bị trừ. Trong lúc chờ bạn vẫn đọc, ghim và duyệt câu hỏi bình thường.</p>
      </div>
    </div>
  )
}

// Chip nhỏ cạnh tên thương hiệu: còn bao nhiêu credits, hết thì hiện thời gian chờ
export function CreditChip() {
  const s = useCreditState()
  if (!s.credits) return null

  const { credits, left, empty, low } = s
  const label = empty
    ? `Hết credits, làm mới sau ${formatCountdown(left)}`
    : `Còn ${credits.remaining} trên ${s.limit} AI credits`

  return (
    <a className={`credit-chip${empty ? ' is-empty' : low ? ' is-low' : ''}`} href="#/questions" aria-label={label} title={label}>
      <Icon name={empty ? 'clock' : 'spark'} size={14} />
      <span>{empty ? formatCountdownShort(left) : credits.remaining}</span>
    </a>
  )
}

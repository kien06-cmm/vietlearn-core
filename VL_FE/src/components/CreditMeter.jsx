// Chức năng: hiển thị AI credits - thẻ đầy đủ (thanh còn lại, đếm ngược tới lúc làm mới, thông báo khi hết) và chip nhỏ trên thanh đầu trang.
import { useCountdown, useCredits } from '../hooks/useCredits.jsx'
import { formatCountdown, formatCountdownShort, formatResetAt, resetDate } from '../services/credits.js'
import Icon from './Icon.jsx'

const LOW_RATIO = 0.2 // còn dưới 20% thì đổi sang màu cảnh báo nhẹ

function useCreditState() {
  const { credits } = useCredits()
  const at = credits ? resetDate(credits) : null
  const left = useCountdown(at)
  if (!credits) return { credits: null }

  const empty = credits.remaining <= 0
  const low = !empty && credits.limit > 0 && credits.remaining / credits.limit <= LOW_RATIO
  const ratio = credits.limit > 0 ? Math.min(1, credits.remaining / credits.limit) : 0
  return { credits, at, left, empty, low, ratio }
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

  const { credits, at, left, empty, low, ratio } = s
  const state = empty ? ' is-empty' : low ? ' is-low' : ''

  return (
    <section className={`credit-card${compact ? ' is-compact' : ''}${state}`} aria-live="polite">
      <div className="credit-head">
        <span className="credit-icon" aria-hidden="true">
          <Icon name={empty ? 'clock' : 'spark'} size={compact ? 18 : 20} />
        </span>
        <div className="credit-title">
          <p className="credit-label">AI credits</p>
          <p className="credit-num">
            <strong>{credits.remaining}</strong>
            <span>/{credits.limit}</span>
          </p>
        </div>
        {note && <p className="credit-note">{note}</p>}
      </div>

      <div
        className="meter"
        role="meter"
        aria-label="AI credits còn lại"
        aria-valuemin={0}
        aria-valuemax={credits.limit}
        aria-valuenow={credits.remaining}
      >
        <span style={{ width: `${ratio * 100}%` }} />
      </div>

      {empty ? (
        <div className="credit-wait" role="status">
          <p className="credit-wait-title">Bạn đã dùng hết credits.</p>
          <p className="credit-wait-text">
            Dùng lại được sau <b className="count">{formatCountdown(left)}</b>
          </p>
          <p className="hint">Lúc {formatResetAt(at)}. Trong lúc chờ bạn vẫn đọc, ghim và duyệt câu hỏi bình thường.</p>
        </div>
      ) : (
        <p className="credit-reset">
          <Icon name="refresh" size={14} />
          {low ? 'Sắp hết. ' : ''}Làm mới sau {formatCountdown(left)}
        </p>
      )}
    </section>
  )
}

// Chip nhỏ cạnh tên thương hiệu: còn bao nhiêu credits, hết thì hiện thời gian chờ
export function CreditChip() {
  const s = useCreditState()
  if (!s.credits) return null

  const { credits, left, empty, low } = s
  const label = empty
    ? `Hết credits, làm mới sau ${formatCountdown(left)}`
    : `Còn ${credits.remaining} trên ${credits.limit} AI credits`

  return (
    <a className={`credit-chip${empty ? ' is-empty' : low ? ' is-low' : ''}`} href="#/questions" aria-label={label} title={label}>
      <Icon name={empty ? 'clock' : 'spark'} size={14} />
      <span>{empty ? formatCountdownShort(left) : credits.remaining}</span>
    </a>
  )
}

// Chức năng: kết quả sau khi nộp bài (Phase 4) - điểm, số câu đúng/sai/bỏ qua, và xem lại từng câu với đáp án đúng và giải thích.
import { useState } from 'react'
import { CONFIDENCE_LABELS, CONFIDENCE_LEVELS, ERROR_LABELS, ERROR_TYPES, LETTERS, STATUS_LABELS, tfText } from '../services/attemptText.js'
import Icon from './Icon.jsx'
import MathText from './MathText.jsx'
import { TYPE_LABELS } from './QuestionCard.jsx'
import '../pages/Questions.css'
import '../pages/Quizzes.css'
import '../pages/Attempt.css'

const hasIndex = (v, idx) => (Array.isArray(v) ? v.includes(idx) : v === idx)

// Hiển thị câu trả lời của người làm và đáp án đúng cho từng dạng câu
export function ReviewBody({ item }) {
  const { type, options, given, correct, alternatives } = item

  if (type === 'single' || type === 'multi') {
    return (
      <ul className="q-options">
        {options.map((o, pos) => {
          const isCorrect = hasIndex(correct, o.index)
          const isGiven = hasIndex(given, o.index)
          const cls = `q-option${isCorrect ? ' q-option-correct' : ''}${isGiven && !isCorrect ? ' q-option-wrong' : ''}`
          return (
            <li key={o.index} className={cls}>
              <span className="q-option-mark">{LETTERS[pos]}</span>
              <span className="choice-text">
                <MathText text={o.text} />
              </span>
              {isGiven && <span className="review-tag">Bạn chọn</span>}
              {isCorrect && <span className="review-tag review-tag-ok">Đáp án đúng</span>}
            </li>
          )
        })}
      </ul>
    )
  }

  if (type === 'truefalse') {
    return (
      <div className="review-lines">
        <p>
          Bạn chọn: <strong>{given === null ? 'Bỏ qua' : tfText(given)}</strong>
        </p>
        <p>
          Đáp án đúng: <strong>{tfText(correct)}</strong>
        </p>
      </div>
    )
  }

  // fill, short
  return (
    <div className="review-lines">
      <p>
        Bạn trả lời: <strong>{given ? given : 'Bỏ qua'}</strong>
      </p>
      <div className="q-answer">
        <p>
          {type === 'short' ? 'Đáp án mẫu: ' : 'Đáp án đúng: '}
          <strong>
            <MathText text={String(correct ?? '')} />
          </strong>
        </p>
        {alternatives?.length > 0 && <p className="hint">Cũng chấp nhận: {alternatives.join(' · ')}</p>}
      </div>
    </div>
  )
}

// Thống kê đúng/sai theo mức tự tin + gợi ý
function ConfidenceSummary({ summary }) {
  if (!summary || summary.rated === 0) return null
  return (
    <section className="card">
      <h2>Mức tự tin của bạn</h2>
      <ul className="conf-rows">
        {CONFIDENCE_LEVELS.map((c) => {
          const l = summary.levels[c.value]
          const total = l.correct + l.wrong
          if (!total) return null
          return (
            <li key={c.value} className="conf-row">
              <span>{c.label}</span>
              <strong>
                Đúng {l.correct}/{total}
              </strong>
            </li>
          )
        })}
      </ul>
      {summary.sureWrong > 0 && (
        <p className="hint">
          Gợi ý: {summary.sureWrong} câu bạn chọn “Chắc chắn” nhưng sai. Nên xem lại cách hiểu ở những câu này.
        </p>
      )}
      {summary.guessCorrect > 0 && (
        <p className="hint">Gợi ý: {summary.guessCorrect} câu bạn đoán trúng. Chưa chắc đã nắm kiến thức, nên ôn lại.</p>
      )}
    </section>
  )
}

const ERROR_HINT_BY = Object.fromEntries(ERROR_TYPES.map((e) => [e.value, e.hint]))

// Gợi ý nguyên nhân sai: backend phân loại theo luật cố định nên chỉ là gợi ý, không khẳng định tuyệt đối
function ErrorSummary({ summary }) {
  const rows = ERROR_TYPES.filter((e) => summary?.[e.value] > 0)
  if (rows.length === 0) return null
  return (
    <section className="card">
      <h2>Gợi ý nguyên nhân sai</h2>
      <ul className="conf-rows">
        {rows.map((e) => (
          <li key={e.value} className="conf-row">
            <span>{e.label}</span>
            <strong>{summary[e.value]} câu</strong>
          </li>
        ))}
      </ul>
      <p className="hint">
        Đây chỉ là gợi ý dựa trên mức tự tin, thời gian làm và số lần đổi đáp án, không phải kết luận chắc chắn.
      </p>
    </section>
  )
}

// Kết quả theo chủ đề, chủ đề yếu nhất lên đầu
function TopicSummary({ topics }) {
  return (
    <section className="card">
      <h2>Theo chủ đề</h2>
      <ul className="topic-rows">
        {topics.map((t) => {
          const pct = Math.round((t.correct / t.total) * 100)
          return (
            <li key={t.topicId || 'none'} className="topic-row">
              <div className="topic-row-head">
                <span>{t.name || 'Chưa rõ chủ đề'}</span>
                <strong>
                  {t.correct}/{t.total}
                </strong>
              </div>
              {(t.subject || t.chapter) && <span className="hint">{[t.subject, t.chapter].filter(Boolean).join(' · ')}</span>}
              <div className="topic-bar" role="img" aria-label={`Đúng ${pct}%`}>
                <div className="topic-bar-fill" style={{ width: `${pct}%` }} />
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export default function AttemptResult({ res, onExit, onRetry, exitLabel = 'Về danh sách quiz', onCreateAccount }) {
  const [onlyMissed, setOnlyMissed] = useState(false)
  const { attempt, review, confidenceSummary, errorSummary, topics } = res
  const r = attempt.result
  const shown = onlyMissed ? review.filter((x) => x.status === 'wrong' || x.status === 'unanswered') : review
  const missed = review.filter((x) => x.status === 'wrong' || x.status === 'unanswered').length

  return (
    <>
      <section>
        <button className="btn btn-secondary" onClick={onExit}>
          <Icon name="back" size={18} /> {exitLabel}
        </button>
        <h1>Kết quả</h1>
        <p className="hint">{attempt.title}</p>
      </section>

      <section className="card result-card">
        {r.score10 != null ? (
          <>
            <p className="result-score">
              <span>{r.score10}</span>/10
            </p>
            <p className="result-sub">
              Đúng {r.correct}/{r.gradable} câu ({r.percent}%)
            </p>
          </>
        ) : (
          <p className="result-sub">Quiz này chỉ có câu trả lời ngắn nên không có điểm tự động.</p>
        )}
        <div className="quiz-meta">
          <span className="chip">Đúng {r.correct}</span>
          <span className="chip">Sai {r.wrong}</span>
          <span className="chip">Bỏ qua {r.unanswered}</span>
          {r.pending > 0 && <span className="chip">Tự đối chiếu {r.pending}</span>}
        </div>
        {attempt.submitReason === 'timeout' && <p className="msg-warn">Đã hết giờ nên bài được nộp tự động theo phần đã lưu.</p>}
        {attempt.submitReason === 'room-ended' && (
          <p className="msg-warn">Phòng đã kết thúc nên bài được nộp tự động theo phần đã lưu.</p>
        )}
        {r.pending > 0 && <p className="hint">Câu trả lời ngắn không được tính vào điểm. Hãy đối chiếu với đáp án mẫu bên dưới.</p>}
        <div className="doc-actions">
          {onRetry && (
            <button className="btn btn-primary" onClick={onRetry}>
              Làm lại
            </button>
          )}
          <button className="btn btn-secondary" onClick={onExit}>
            {exitLabel}
          </button>
        </div>
      </section>

      {onCreateAccount && (
        <section className="card">
          <h2>Lưu kết quả này</h2>
          <p className="hint">
            Bạn đang vào với tư cách khách nên kết quả chỉ giữ trên máy này trong vài giờ. Tạo tài khoản miễn phí, kết quả và các câu sai sẽ được chuyển sang sổ lỗi sai để ôn lại theo lịch 1 → 3 → 7 ngày.
          </p>
          <button className="btn btn-primary" onClick={onCreateAccount}>
            Tạo tài khoản để lưu kết quả
          </button>
        </section>
      )}

      <ConfidenceSummary summary={confidenceSummary} />
      <ErrorSummary summary={errorSummary} />
      {topics?.length > 0 && <TopicSummary topics={topics} />}

      <section>
        <h2>Xem lại bài</h2>
        {missed > 0 && (
          <label className="check-row">
            <input type="checkbox" checked={onlyMissed} onChange={(e) => setOnlyMissed(e.target.checked)} />
            Chỉ hiện câu sai và câu bỏ qua ({missed})
          </label>
        )}
      </section>

      {shown.map((item) => {
        const no = review.indexOf(item) + 1
        return (
          <article key={item.id} className="card">
            <div className="q-top">
              <span className="badge">Câu {no}</span>
              <span className="badge">{TYPE_LABELS[item.type] || item.type}</span>
              <span className={`badge review-status review-status-${item.status}`}>{STATUS_LABELS[item.status]}</span>
              {item.confidence && <span className="badge">Tự tin: {CONFIDENCE_LABELS[item.confidence]}</span>}
              {item.changes > 0 && <span className="badge">Đổi đáp án {item.changes} lần</span>}
              {item.errorType && <span className="badge">Gợi ý: {ERROR_LABELS[item.errorType]}</span>}
            </div>
            <p className="q-stem">
              <MathText text={item.stem} />
            </p>
            <ReviewBody item={item} />
            {item.errorType && <p className="hint">{ERROR_HINT_BY[item.errorType]}</p>}
            {item.explanation && (
              <p className="q-explain">
                <strong>Giải thích: </strong>
                <MathText text={item.explanation} />
              </p>
            )}
          </article>
        )
      })}
    </>
  )
}

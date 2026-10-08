// Chức năng: kết quả sau khi nộp bài (Phase 4) - điểm, số câu đúng/sai/bỏ qua, và xem lại từng câu với đáp án đúng và giải thích.
import { useState } from 'react'
import { LETTERS, STATUS_LABELS, tfText } from '../services/attemptText.js'
import Icon from './Icon.jsx'
import MathText from './MathText.jsx'
import { TYPE_LABELS } from './QuestionCard.jsx'
import '../pages/Questions.css'
import '../pages/Quizzes.css'
import '../pages/Attempt.css'

const hasIndex = (v, idx) => (Array.isArray(v) ? v.includes(idx) : v === idx)

// Hiển thị câu trả lời của người làm và đáp án đúng cho từng dạng câu
function ReviewBody({ item }) {
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

export default function AttemptResult({ res, onExit, onRetry }) {
  const [onlyMissed, setOnlyMissed] = useState(false)
  const { attempt, review } = res
  const r = attempt.result
  const shown = onlyMissed ? review.filter((x) => x.status === 'wrong' || x.status === 'unanswered') : review
  const missed = review.filter((x) => x.status === 'wrong' || x.status === 'unanswered').length

  return (
    <>
      <section>
        <button className="btn btn-secondary" onClick={onExit}>
          <Icon name="back" size={18} /> Danh sách quiz
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
        {r.pending > 0 && <p className="hint">Câu trả lời ngắn không được tính vào điểm. Hãy đối chiếu với đáp án mẫu bên dưới.</p>}
        <div className="doc-actions">
          {onRetry && (
            <button className="btn btn-primary" onClick={onRetry}>
              Làm lại
            </button>
          )}
          <button className="btn btn-secondary" onClick={onExit}>
            Về danh sách quiz
          </button>
        </div>
      </section>

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
            </div>
            <p className="q-stem">
              <MathText text={item.stem} />
            </p>
            <ReviewBody item={item} />
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

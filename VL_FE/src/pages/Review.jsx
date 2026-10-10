// Chức năng: trang Ôn tập (Phase 5) - hôm nay cần ôn bao nhiêu câu, làm bài ôn từng câu (có phản hồi ngay, cập nhật lịch 1 -> 3 -> 7 ngày), và Sổ lỗi sai (đáp án đúng, gợi ý kiểu sai, đáp án hay chọn nhầm).
// Câu sai ở bài làm bình thường tự vào sổ khi nộp bài (chỉ tài khoản). Đáp án đúng chỉ hiện sau khi bạn đã trả lời câu đó.
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  completeFinishedTopic,
  generatePractice,
  getFinishedTopics,
  getJob,
  getPracticeQuestions,
  getReviewQuestions,
  getReviewSubjects,
  getReviewSummary,
  gradeReview,
  listMistakes,
  restartFinishedTopic,
} from '../services/api.js'
import { CONFIDENCE_LEVELS, ERROR_LABELS, ERROR_TYPES, LETTERS, isAnswered, tfText } from '../services/attemptText.js'
import { QuestionInput } from '../components/AttemptRunner.jsx'
import { ReviewBody } from '../components/AttemptResult.jsx'
import { TYPE_LABELS } from '../components/QuestionCard.jsx'
import MathText from '../components/MathText.jsx'
import Icon from '../components/Icon.jsx'
import KnowledgeMap from '../components/KnowledgeMap.jsx'
import './Questions.css'
import './Quizzes.css'
import './Attempt.css'
import './Review.css'

const SESSION_SIZE = 10
const INTERVAL_TEXT = ['1 ngày', '3 ngày', '7 ngày'] // khớp REVIEW_INTERVALS_DAYS ở backend
const AI_PRACTICE_COUNT = 5
const AI_POLL_MS = 2000
const AI_POLL_MAX = 60 // chờ tối đa ~2 phút; job vẫn chạy tiếp phía server nên câu mới sẽ có ở lần luyện sau

// Nhờ AI soạn thêm câu luyện cho chủ đề từ các câu bạn từng sai (bám đoạn tài liệu gốc). Tốn AI credits nên chỉ chạy khi bấm nút.
function AiPractice({ getToken, topic, onDone }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  async function start() {
    setBusy(true)
    setError('')
    try {
      const { jobId } = await generatePractice(await getToken(), { topicId: topic.id, count: AI_PRACTICE_COUNT })
      for (let i = 0; i < AI_POLL_MAX; i++) {
        await new Promise((resolve) => setTimeout(resolve, AI_POLL_MS))
        if (!alive.current) return
        const { job } = await getJob(await getToken(), jobId)
        if (job.status === 'done') {
          onDone()
          return
        }
        if (job.status === 'failed') throw new Error(job.error || 'AI chưa tạo được câu luyện. Credits đã được hoàn lại.')
      }
      throw new Error('AI đang tạo lâu hơn dự kiến. Câu mới sẽ có trong lần luyện sau, bạn không cần bấm lại.')
    } catch (err) {
      if (alive.current) setError(err.message)
    } finally {
      if (alive.current) setBusy(false)
    }
  }

  return (
    <div className="ai-practice">
      <p className="hint">
        Muốn thêm câu mới? AI sẽ soạn {AI_PRACTICE_COUNT} câu từ đúng đoạn tài liệu của những câu bạn từng sai ở chủ đề này. Tốn tối đa {AI_PRACTICE_COUNT} AI credits, phần không dùng được hoàn lại. Câu AI tạo chưa được duyệt nên sẽ có nhãn.
      </p>
      {error && (
        <p className="msg msg-error" role="alert">
          {error}
        </p>
      )}
      <button className="btn btn-secondary" disabled={busy} onClick={start}>
        {busy ? 'Đang tạo câu luyện...' : 'Tạo thêm câu luyện bằng AI'}
      </button>
    </div>
  )
}

// "Ôn lại sau 2 ngày" / "Đã đến hạn ôn". nowMs lấy từ giờ server để không lệch theo đồng hồ máy.
function dueText(iso, nowMs) {
  if (!iso) return ''
  const ms = Date.parse(iso) - nowMs
  if (ms <= 0) return 'Đã đến hạn ôn'
  const hours = Math.ceil(ms / 3_600_000)
  return hours < 24 ? `Ôn lại sau ${hours} giờ` : `Ôn lại sau ${Math.ceil(hours / 24)} ngày`
}

// Dòng báo lịch ôn sau khi chấm. Câu từ ngân hàng (fresh) đúng thì không vào sổ, sai thì vừa được thêm vào sổ.
function nextText(f) {
  if (f.fresh) return f.status === 'correct' ? 'Câu này đúng nên không vào sổ lỗi sai.' : 'Câu này đã được thêm vào sổ lỗi sai. Ôn lại sau 1 ngày.'
  if (f.mastered) return 'Bạn đã nắm câu này, nó sẽ không xuất hiện lại trừ khi bạn làm sai.'
  return `Ôn lại sau ${INTERVAL_TEXT[f.stage] || '1 ngày'}.`
}

// ---------------------------------------------------------------------------
// Làm bài ôn: mỗi lần một câu, chấm ngay để có phản hồi, lịch ôn được cập nhật ở server
// topic ({ id, name }): luyện phần yếu của một chủ đề thay vì ôn theo lịch
// subject: chỉ ôn câu của môn đó (chuỗi rỗng = tất cả các môn); không dùng khi đang luyện một chủ đề
// ---------------------------------------------------------------------------
function ReviewSession({ getToken, scope, subject, topic, onDone }) {
  const backText = topic ? 'Về Bản đồ kiến thức' : 'Về Ôn tập'
  const [questions, setQuestions] = useState(null) // null: đang tải
  const [error, setError] = useState('')
  const [index, setIndex] = useState(0)
  const [answer, setAnswer] = useState(null)
  const [level, setLevel] = useState(null)
  const [feedback, setFeedback] = useState(null) // kết quả chấm của câu đang xem
  const [busy, setBusy] = useState(false)
  const [tally, setTally] = useState({ correct: 0, wrong: 0, mastered: 0 })
  const [reloadKey, setReloadKey] = useState(0) // đổi giá trị này thì tải lại bộ câu từ đầu

  // AI vừa tạo xong câu luyện mới: tải lại bộ câu (câu mới nằm trong bộ này)
  function reloadAfterGenerate() {
    setQuestions(null)
    setIndex(0)
    setAnswer(null)
    setLevel(null)
    setFeedback(null)
    setError('')
    setTally({ correct: 0, wrong: 0, mastered: 0 })
    setReloadKey((k) => k + 1)
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const token = await getToken()
        const res = topic
          ? await getPracticeQuestions(token, { topicId: topic.id, limit: SESSION_SIZE })
          : await getReviewQuestions(token, { scope, limit: SESSION_SIZE, subject })
        if (!cancelled) setQuestions(res.questions)
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [getToken, scope, subject, topic, reloadKey])

  if (error && !questions) {
    return (
      <section className="card">
        <p className="msg msg-error" role="alert">
          {error}
        </p>
        <button className="btn btn-secondary" onClick={onDone}>
          {backText}
        </button>
      </section>
    )
  }

  if (!questions) return <p className="hint">Đang tải câu cần ôn...</p>

  if (questions.length === 0) {
    return (
      <section className="card empty">
        <h2>{topic ? 'Chưa có câu để luyện' : 'Không có câu nào cần ôn'}</h2>
        <p className="hint">
          {topic
            ? 'Chủ đề này chưa có câu nào bạn từng sai, và chưa có câu đã duyệt trong ngân hàng của bạn.'
            : 'Khi bạn làm sai ở quiz hoặc phòng, câu đó sẽ vào sổ lỗi sai và quay lại đây theo lịch.'}
        </p>
        <button className="btn btn-secondary" onClick={onDone}>
          {backText}
        </button>
      </section>
    )
  }

  // Ôn xong tất cả câu
  if (index >= questions.length) {
    return (
      <section className="card result-card">
        <h2>{topic ? `Xong lượt luyện: ${topic.name || 'chủ đề'}` : 'Xong lượt ôn'}</h2>
        <p className="result-sub">
          Đúng {tally.correct}/{questions.length} câu
        </p>
        <div className="quiz-meta">
          <span className="chip">Đúng {tally.correct}</span>
          <span className="chip">Sai {tally.wrong}</span>
          {tally.mastered > 0 && <span className="chip">Đã nắm {tally.mastered}</span>}
        </div>
        <p className="hint">Câu sai sẽ quay lại sau 1 ngày. Câu đúng được hẹn lần ôn xa hơn.</p>
        {topic && <AiPractice getToken={getToken} topic={topic} onDone={reloadAfterGenerate} />}
        <button className="btn btn-primary" onClick={onDone}>
          {backText}
        </button>
      </section>
    )
  }

  const q = questions[index]

  async function check() {
    setBusy(true)
    setError('')
    try {
      const res = await gradeReview(await getToken(), { [q.id]: answer }, level ? { [q.id]: level } : undefined)
      const item = res.items[0]
      if (!item) {
        setError('Chưa chấm được câu này. Hãy chọn hoặc nhập đáp án rồi thử lại.')
        return
      }
      setFeedback(item)
      setTally((t) => ({
        correct: t.correct + (item.status === 'correct' ? 1 : 0),
        wrong: t.wrong + (item.status === 'wrong' ? 1 : 0),
        mastered: t.mastered + (item.mastered ? 1 : 0),
      }))
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  function next() {
    setIndex(index + 1)
    setAnswer(null)
    setLevel(null)
    setFeedback(null)
    setError('')
  }

  return (
    <>
      <section>
        <button className="btn btn-secondary" onClick={onDone}>
          <Icon name="back" size={18} /> Dừng ôn
        </button>
        <p className="hint review-progress">
          Câu {index + 1}/{questions.length}
        </p>
      </section>

      <article className="card">
        <div className="q-top">
          <span className="badge">{TYPE_LABELS[q.type] || q.type}</span>
          <span className="badge">
            {q.fresh ? (q.unreviewed ? 'Câu AI tạo, chưa duyệt' : 'Câu từ ngân hàng') : q.stage < INTERVAL_TEXT.length ? `Lần ôn thứ ${q.stage + 1}` : 'Ôn lại câu đã nắm'}
          </span>
        </div>
        <p className="q-stem">
          <MathText text={q.stem} />
        </p>
        {q.unreviewed && (
          <p className="hint">Câu này do AI soạn từ tài liệu của bạn và chưa được duyệt. Nếu thấy đáp án có vẻ sai, hãy kiểm tra lại ở mục Câu hỏi.</p>
        )}

        {!feedback && (
          <>
            <QuestionInput key={q.id} q={q} value={answer} onChange={setAnswer} />
            {isAnswered(answer) && (
              <div className="confidence" role="radiogroup" aria-label="Mức tự tin">
                <span className="confidence-label">Mức tự tin (không bắt buộc, giúp xếp lịch ôn chính xác hơn)</span>
                <div className="confidence-options">
                  {CONFIDENCE_LEVELS.map((c) => (
                    <button
                      key={c.value}
                      type="button"
                      role="radio"
                      aria-checked={level === c.value}
                      className={`confidence-btn${level === c.value ? ' confidence-btn-on' : ''}`}
                      onClick={() => setLevel(level === c.value ? null : c.value)}
                    >
                      {c.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {error && (
              <p className="msg msg-error" role="alert">
                {error}
              </p>
            )}
            <button className="btn btn-primary" disabled={busy || !isAnswered(answer)} onClick={check}>
              {busy ? 'Đang chấm...' : 'Kiểm tra'}
            </button>
          </>
        )}

        {feedback && (
          <>
            <p className={`review-verdict review-verdict-${feedback.status}`} role="status">
              {feedback.status === 'correct' ? 'Chính xác' : 'Chưa đúng'}
            </p>
            <ReviewBody
              item={{ type: q.type, options: q.options, given: feedback.given, correct: feedback.correct, alternatives: feedback.alternatives }}
            />
            {feedback.explanation && (
              <p className="q-explain">
                <strong>Giải thích: </strong>
                <MathText text={feedback.explanation} />
              </p>
            )}
            <p className="hint">
              {nextText(feedback)}
              {feedback.status === 'correct' && level === 'guess' && ' Bạn đánh dấu “Đoán” nên câu này chưa được tính là đã nắm.'}
              {feedback.status === 'correct' && level === 'unsure' && ' Bạn còn phân vân nên cần thêm một lần ôn nữa trước khi coi là đã nắm.'}
            </p>
            <button className="btn btn-primary" onClick={next}>
              {index + 1 < questions.length ? 'Câu tiếp theo' : 'Xem kết quả'}
            </button>
          </>
        )}
      </article>
    </>
  )
}

// ---------------------------------------------------------------------------
// Sổ lỗi sai
// ---------------------------------------------------------------------------

// Chỉ đáp án đúng (sổ không hỏi lại nên không có phần "bạn chọn")
function CorrectAnswer({ m }) {
  if (m.type === 'single' || m.type === 'multi') {
    const right = Array.isArray(m.correct) ? m.correct : [m.correct]
    return (
      <ul className="q-options">
        {m.options.map((o) => {
          const ok = right.includes(o.index)
          return (
            <li key={o.index} className={`q-option${ok ? ' q-option-correct' : ''}`}>
              <span className="q-option-mark">{LETTERS[o.index]}</span>
              <span className="choice-text">
                <MathText text={o.text} />
              </span>
              {ok && <span className="review-tag review-tag-ok">Đáp án đúng</span>}
            </li>
          )
        })}
      </ul>
    )
  }
  const text = m.type === 'truefalse' ? tfText(m.correct) : String(m.correct ?? '')
  return (
    <div className="review-lines">
      <p>
        Đáp án đúng:{' '}
        <strong>
          <MathText text={text} />
        </strong>
      </p>
      {m.alternatives?.length > 0 && <p className="hint">Cũng chấp nhận: {m.alternatives.join(' · ')}</p>}
    </div>
  )
}

function MistakeList({ getToken, status }) {
  const [data, setData] = useState(null) // null: đang tải
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await listMistakes(await getToken(), status)
        if (!cancelled) setData(res)
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [getToken, status])

  if (error) {
    return (
      <p className="msg msg-error" role="alert">
        {error}
      </p>
    )
  }
  if (!data) return <p className="hint">Đang tải sổ lỗi sai...</p>

  const nowMs = Date.parse(data.serverNow)
  const { mistakes, summary } = data

  if (mistakes.length === 0) {
    return (
      <section className="card empty">
        <h2>{status === 'open' ? 'Sổ lỗi sai đang trống' : 'Chưa có câu nào được nắm'}</h2>
        <p className="hint">
          {status === 'open'
            ? 'Những câu bạn làm sai ở quiz hoặc phòng sẽ tự vào đây khi nộp bài.'
            : 'Làm đúng một câu qua cả ba mốc ôn 1, 3 và 7 ngày thì câu đó được coi là đã nắm.'}
        </p>
      </section>
    )
  }

  const errorRows = summary ? ERROR_TYPES.filter((e) => summary.byErrorType[e.value] > 0) : []

  return (
    <>
      {summary && (errorRows.length > 0 || summary.weakTopics.length > 0) && (
        <section className="card">
          <h2>Tổng quan {summary.total} câu đang ôn</h2>
          {errorRows.length > 0 && (
            <div className="quiz-meta">
              {errorRows.map((e) => (
                <span key={e.value} className="chip">
                  {e.label}: {summary.byErrorType[e.value]}
                </span>
              ))}
            </div>
          )}
          {summary.weakTopics.length > 0 && (
            <ul className="conf-rows">
              {summary.weakTopics.map((t) => (
                <li key={t.topicId || 'none'} className="conf-row">
                  <span>{t.name || 'Chưa rõ chủ đề'}</span>
                  <strong>{t.mistakes} câu</strong>
                </li>
              ))}
            </ul>
          )}
          <p className="hint">Kiểu sai chỉ là gợi ý theo luật cố định, không phải kết luận chắc chắn.</p>
        </section>
      )}

      {mistakes.map((m) => (
        <article key={m.id} className="card">
          <div className="q-top">
            <span className="badge">{TYPE_LABELS[m.type] || m.type}</span>
            {m.topicName && <span className="badge">{m.topicName}</span>}
            <span className="badge">Sai {m.wrongCount} lần</span>
            {m.errorType && <span className="badge">Gợi ý: {ERROR_LABELS[m.errorType]}</span>}
          </div>
          <p className="q-stem">
            <MathText text={m.stem} />
          </p>
          {m.topWrong && (
            <p className="hint">
              Bạn hay chọn nhầm:{' '}
              <strong>
                {LETTERS[m.topWrong.index]}. <MathText text={m.topWrong.text} />
              </strong>{' '}
              ({m.topWrong.count} lần)
            </p>
          )}
          <p className="hint">{status === 'open' ? dueText(m.nextReviewAt, nowMs) : 'Đã nắm'}</p>
          <details className="review-answer">
            <summary>Xem đáp án và giải thích</summary>
            <CorrectAnswer m={m} />
            {m.explanation && (
              <p className="q-explain">
                <strong>Giải thích: </strong>
                <MathText text={m.explanation} />
              </p>
            )}
          </details>
        </article>
      ))}
    </>
  )
}

function Notebook({ getToken, onBack }) {
  const [tab, setTab] = useState('open')
  return (
    <>
      <section>
        <button className="btn btn-secondary" onClick={onBack}>
          <Icon name="back" size={18} /> Ôn tập
        </button>
        <h1>Sổ lỗi sai</h1>
      </section>
      <div className="review-tabs" role="group" aria-label="Lọc sổ lỗi sai">
        <button className={`review-tab${tab === 'open' ? ' review-tab-on' : ''}`} aria-pressed={tab === 'open'} onClick={() => setTab('open')}>
          Đang ôn
        </button>
        <button
          className={`review-tab${tab === 'mastered' ? ' review-tab-on' : ''}`}
          aria-pressed={tab === 'mastered'}
          onClick={() => setTab('mastered')}
        >
          Đã nắm
        </button>
      </div>
      {/* key theo tab: đổi tab thì tải lại từ đầu */}
      <MistakeList key={tab} getToken={getToken} status={tab} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Chủ đề đã ôn xong: tổng quan + chọn Hoàn thành (lưu trữ, tự xóa sau 90 ngày) hoặc Ôn lại (câu khó / tất cả)
// Lỗi tải danh sách không chặn trang Ôn tập: chỉ ẩn thẻ này.
// ---------------------------------------------------------------------------
function FinishedCard({ getToken, topic, onChanged }) {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false) // đang hỏi lại trước khi Hoàn thành
  const [error, setError] = useState('')

  async function run(action) {
    setBusy(true)
    setError('')
    try {
      await action(await getToken())
      await onChanged()
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  const label = topic.name || (topic.topicId === '_none' ? 'Câu chưa gắn chủ đề' : 'Chủ đề chưa đặt tên')

  return (
    <article className="card finished-card">
      <div className="q-top">
        <span className="badge">Đã ôn xong</span>
        {topic.subject && <span className="badge">{topic.subject}</span>}
      </div>
      <h3 className="finished-title">{label}</h3>
      <div className="quiz-meta">
        <span className="chip">{topic.questions} câu</span>
        <span className="chip">Câu khó {topic.hard}</span>
        <span className="chip">Tổng lần sai {topic.wrongTotal}</span>
        {topic.percent != null && <span className="chip">Thành thạo {topic.percent}%</span>}
      </div>

      {topic.hardest.length > 0 && (
        <>
          <p className="hint">Những câu khó nhất:</p>
          <ul className="conf-rows">
            {topic.hardest.map((h) => (
              <li key={h.id} className="conf-row">
                <span className="finished-stem">
                  <MathText text={h.stem} />
                </span>
                <strong>Sai {h.wrongCount} lần</strong>
              </li>
            ))}
          </ul>
        </>
      )}

      {error && (
        <p className="msg msg-error" role="alert">
          {error}
        </p>
      )}

      {confirming ? (
        <>
          <p className="hint">
            Hoàn thành sẽ lưu trữ {topic.questions} câu của chủ đề này, không còn hiện trong sổ lỗi sai và tự xóa sau 90 ngày. Nếu bạn làm sai lại một câu thì câu đó tự mở lại.
          </p>
          <div className="doc-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => run((t) => completeFinishedTopic(t, topic.topicId))}>
              {busy ? 'Đang lưu...' : 'Xác nhận hoàn thành'}
            </button>
            <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
              Hủy
            </button>
          </div>
        </>
      ) : (
        <div className="doc-actions">
          <button className="btn btn-primary" disabled={busy} onClick={() => setConfirming(true)}>
            Hoàn thành
          </button>
          {topic.hard > 0 && (
            <button className="btn btn-secondary" disabled={busy} onClick={() => run((t) => restartFinishedTopic(t, topic.topicId, 'hard'))}>
              Ôn lại {topic.hard} câu khó
            </button>
          )}
          <button className="btn btn-secondary" disabled={busy} onClick={() => run((t) => restartFinishedTopic(t, topic.topicId, 'all'))}>
            Ôn lại tất cả
          </button>
        </div>
      )}
    </article>
  )
}

function FinishedTopics({ getToken, reloadKey, onChanged }) {
  const [topics, setTopics] = useState([])

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await getFinishedTopics(await getToken())
        if (!cancelled) setTopics(res.topics)
      } catch {
        if (!cancelled) setTopics([]) // thẻ phụ: lỗi thì ẩn, không làm hỏng trang
      }
    })()
    return () => {
      cancelled = true
    }
  }, [getToken, reloadKey])

  if (topics.length === 0) return null
  return (
    <>
      <section>
        <h2>Chủ đề đã ôn xong</h2>
        <p className="hint">Bạn đã nắm mọi câu sai của các chủ đề này. Hoàn thành để dọn khỏi sổ, hoặc ôn lại nếu muốn chắc hơn.</p>
      </section>
      {topics.map((t) => (
        <FinishedCard key={t.topicId} getToken={getToken} topic={t} onChanged={onChanged} />
      ))}
    </>
  )
}

// ---------------------------------------------------------------------------
// Trang chính
// ---------------------------------------------------------------------------
export default function Review({ getToken }) {
  const [view, setView] = useState('home') // home | session | notebook | map
  const [scope, setScope] = useState('due')
  const [practice, setPractice] = useState(null) // { id, name }: đang luyện phần yếu của một chủ đề (bắt đầu từ Bản đồ kiến thức)
  const [summary, setSummary] = useState(null) // null: đang tải
  const [subjects, setSubjects] = useState([]) // các môn có câu đang ôn: [{ subject, open, due }]
  const [subject, setSubject] = useState('') // môn đang chọn ('' = tất cả)
  const [error, setError] = useState('')
  const [finishedKey, setFinishedKey] = useState(0) // đổi giá trị này thì tải lại danh sách chủ đề đã ôn xong

  const loadSummary = useCallback(async () => {
    try {
      const token = await getToken()
      const [sum, subj] = await Promise.all([getReviewSummary(token), getReviewSubjects(token)])
      setSummary(sum)
      setSubjects(subj.subjects)
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [getToken])

  useEffect(() => {
    loadSummary()
  }, [loadSummary])

  // Luyện xong thì quay lại Bản đồ kiến thức (nó tự tải lại nên thấy mức thành thạo mới)
  function back() {
    setView(practice ? 'map' : 'home')
    setPractice(null)
    loadSummary()
    setFinishedKey((k) => k + 1)
  }

  // Vừa Hoàn thành hoặc Ôn lại một chủ đề: số câu cần ôn có thể đổi nên tải lại cả hai
  async function afterFinishedChange() {
    setFinishedKey((k) => k + 1)
    await loadSummary()
  }

  if (view === 'session') return <ReviewSession getToken={getToken} scope={scope} subject={subject} topic={practice} onDone={back} />
  if (view === 'notebook') return <Notebook getToken={getToken} onBack={back} />
  if (view === 'map') {
    return (
      <KnowledgeMap
        getToken={getToken}
        onBack={back}
        onPractice={(topic) => {
          setPractice(topic)
          setView('session')
        }}
      />
    )
  }

  function start(nextScope) {
    setScope(nextScope)
    setView('session')
  }

  const nowMs = summary ? Date.parse(summary.serverNow) : 0
  // Khi chọn môn thì đếm theo môn đó (môn hết câu đang ôn thì là 0)
  const current = subject ? (subjects.find((s) => s.subject === subject) ?? { due: 0, open: 0 }) : null
  const dueCount = current ? current.due : (summary?.due ?? 0)
  const openCount = current ? current.open : (summary?.open ?? 0)

  return (
    <>
      <section>
        <h1>Ôn tập</h1>
        <p className="hint">Câu bạn làm sai sẽ quay lại theo lịch 1, 3 rồi 7 ngày để nhớ lâu hơn.</p>
      </section>

      {error && (
        <p className="msg msg-error" role="alert">
          {error}
        </p>
      )}

      {summary === null && !error && (
        <section className="hero" aria-hidden="true">
          <span className="skeleton skeleton-line short" />
          <span className="skeleton skeleton-title" />
        </section>
      )}

      {summary && (
        <section className="card review-today" aria-label="Hôm nay cần ôn">
          <p className="hero-label">Hôm nay</p>
          {subjects.length > 1 && (
            <div className="review-tabs" role="group" aria-label="Chọn môn để ôn">
              <button className={`review-tab${subject === '' ? ' review-tab-on' : ''}`} aria-pressed={subject === ''} onClick={() => setSubject('')}>
                Tất cả ({summary.due})
              </button>
              {subjects.map((s) => (
                <button
                  key={s.subject}
                  className={`review-tab${subject === s.subject ? ' review-tab-on' : ''}`}
                  aria-pressed={subject === s.subject}
                  onClick={() => setSubject(s.subject)}
                >
                  {s.subject} ({s.due})
                </button>
              ))}
            </div>
          )}
          <p className="review-count">
            <span>{dueCount}</span> câu cần ôn
          </p>
          {dueCount === 0 && (
            <p className="hint">
              {openCount === 0
                ? 'Chưa có câu nào trong sổ lỗi sai. Làm quiz xong, những câu sai sẽ được thêm vào đây.'
                : current
                  ? 'Môn này chưa có câu nào đến hạn.'
                  : summary.nextDueAt
                    ? `Câu tiếp theo: ${dueText(summary.nextDueAt, nowMs).toLowerCase()}.`
                    : 'Chưa có câu nào đến hạn.'}
            </p>
          )}
          <div className="quiz-meta">
            <span className="chip">Đang ôn {openCount}</span>
            {!current && <span className="chip">Đã nắm {summary.mastered}</span>}
          </div>
          <div className="doc-actions">
            {dueCount > 0 && (
              <button className="btn btn-primary" onClick={() => start('due')}>
                Ôn {Math.min(dueCount, SESSION_SIZE)} câu hôm nay
              </button>
            )}
            {openCount > dueCount && (
              <button className="btn btn-secondary" onClick={() => start('open')}>
                Ôn thêm cả câu chưa đến hạn
              </button>
            )}
          </div>
        </section>
      )}

      <FinishedTopics getToken={getToken} reloadKey={finishedKey} onChanged={afterFinishedChange} />

      <button className="btn btn-secondary" onClick={() => setView('notebook')}>
        Mở sổ lỗi sai
      </button>
      <button className="btn btn-secondary" onClick={() => setView('map')}>
        Bản đồ kiến thức
      </button>
    </>
  )
}

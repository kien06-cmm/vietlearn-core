// Chức năng: màn làm bài trên điện thoại (Phase 4) - mở/tiếp tục lượt làm, đồng hồ đếm ngược theo giờ server, mỗi lần một câu, lưu nháp tự động (có thử lại khi mất mạng), nộp bài, tự nộp khi hết giờ, ghi nhận chuyển tab (có báo trước cho người làm).
// Đáp án đúng không bao giờ nằm trong đề; chỉ lấy được sau khi nộp (AttemptResult).
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  getAttempt,
  getAttemptResult,
  logAttemptEvent,
  saveAttemptAnswers,
  startAttempt,
  startRoomAttempt,
  submitAttempt,
} from '../services/api.js'
import { settingsText } from '../services/quizText.js'
import { CONFIDENCE_LEVELS, LETTERS, formatClock, isAnswered, tfText, timeText } from '../services/attemptText.js'
import Icon from './Icon.jsx'
import MathText from './MathText.jsx'
import AttemptResult from './AttemptResult.jsx'
import { TYPE_LABELS } from './QuestionCard.jsx'
import '../pages/Questions.css'
import '../pages/Quizzes.css'
import '../pages/Attempt.css'

const SAVE_DEBOUNCE_MS = 1200
const SAVE_RETRY_MS = 5000
const MAX_SPENT_MS = 3_600_000

// Ô nhập câu trả lời theo từng dạng câu hỏi
export function QuestionInput({ q, value, onChange }) {
  if (q.type === 'single') {
    return (
      <div className="choice-list" role="radiogroup">
        {q.options.map((o, pos) => (
          <label key={o.index} className={`choice${value === o.index ? ' choice-on' : ''}`}>
            <input type="radio" name={q.id} checked={value === o.index} onChange={() => onChange(o.index)} />
            <span className="choice-key">{LETTERS[pos]}</span>
            <span className="choice-text">
              <MathText text={o.text} />
            </span>
          </label>
        ))}
      </div>
    )
  }

  if (q.type === 'multi') {
    const picked = Array.isArray(value) ? value : []
    const toggle = (idx) => {
      const next = picked.includes(idx) ? picked.filter((i) => i !== idx) : [...picked, idx]
      onChange(next.sort((a, b) => a - b))
    }
    return (
      <div className="choice-list">
        <p className="hint">Chọn tất cả đáp án đúng. Phải chọn đúng và đủ mới được tính điểm.</p>
        {q.options.map((o, pos) => (
          <label key={o.index} className={`choice${picked.includes(o.index) ? ' choice-on' : ''}`}>
            <input type="checkbox" checked={picked.includes(o.index)} onChange={() => toggle(o.index)} />
            <span className="choice-key">{LETTERS[pos]}</span>
            <span className="choice-text">
              <MathText text={o.text} />
            </span>
          </label>
        ))}
      </div>
    )
  }

  if (q.type === 'truefalse') {
    return (
      <div className="choice-list choice-tf" role="radiogroup">
        {[true, false].map((v) => (
          <label key={String(v)} className={`choice${value === v ? ' choice-on' : ''}`}>
            <input type="radio" name={q.id} checked={value === v} onChange={() => onChange(v)} />
            <span className="choice-text">{tfText(v)}</span>
          </label>
        ))}
      </div>
    )
  }

  if (q.type === 'fill') {
    return (
      <label>
        Điền đáp án
        <input type="text" value={value ?? ''} maxLength={200} autoComplete="off" onChange={(e) => onChange(e.target.value)} />
      </label>
    )
  }

  // short
  return (
    <label>
      Câu trả lời của bạn
      <textarea value={value ?? ''} maxLength={300} rows={4} onChange={(e) => onChange(e.target.value)} />
      <span className="hint">{(value ?? '').length}/300 · Câu này không tự chấm, bạn tự đối chiếu với đáp án mẫu sau khi nộp.</span>
    </label>
  )
}

// roomCode: làm bài trong phòng (không có màn bắt đầu, vào bài ngay; phòng kết thúc thì server nộp bài giúp). getToken dùng được cho cả tài khoản và khách.
export default function AttemptRunner({ getToken, quiz, roomCode, onExit, onRetry, exitLabel, roomEnded = false, live = false, onCreateAccount }) {
  const [phase, setPhase] = useState('intro') // intro | starting | running | submitting | done
  const [error, setError] = useState('')
  const [session, setSession] = useState(null) // { attempt, questions, resumed }
  const [answers, setAnswers] = useState({})
  const [confidence, setConfidence] = useState({})
  const [index, setIndex] = useState(0)
  const [saveState, setSaveState] = useState('idle') // idle | dirty | saving | saved | error
  const [savedAt, setSavedAt] = useState(null)
  const [now, setNow] = useState(() => Date.now())
  const [confirming, setConfirming] = useState(false)
  const [result, setResult] = useState(null)

  const answersRef = useRef({})
  const confidenceRef = useRef({})
  const dirtyRef = useRef(new Set())
  const dirtyConfRef = useRef(new Set())
  const spentRef = useRef({})
  const spentSentRef = useRef({})
  const curQRef = useRef(null)
  const tickRef = useRef(null)
  const savingRef = useRef(false)
  const finishingRef = useRef(false)
  const autoFailedRef = useRef(false)
  const offsetRef = useRef(0) // giờ server trừ giờ máy: để đồng hồ không lệch dù máy chỉnh sai giờ
  const saveTimerRef = useRef(null)
  const finishRef = useRef(null)

  const attemptId = session?.attempt.id
  const questions = session?.questions ?? []
  const deadlineMs = session?.attempt.deadlineAt ? Date.parse(session.attempt.deadlineAt) : null

  // ---------- Bắt đầu / tiếp tục ----------
  async function handleStart() {
    setPhase('starting')
    setError('')
    try {
      const token = await getToken()
      const res = roomCode ? await startRoomAttempt(token, roomCode) : await startAttempt(token, quiz.id)
      offsetRef.current = Date.parse(res.serverNow) - Date.now()
      const saved = res.attempt.answers || {}
      answersRef.current = { ...saved }
      setAnswers({ ...saved })
      const savedConf = res.attempt.confidence || {}
      confidenceRef.current = { ...savedConf }
      setConfidence({ ...savedConf })
      spentRef.current = { ...(res.attempt.spent || {}) }
      spentSentRef.current = { ...spentRef.current }
      setNow(Date.now() + offsetRef.current)
      setSession({ attempt: res.attempt, questions: res.questions || [], resumed: Boolean(res.resumed) })
      setPhase('running')
    } catch (err) {
      setError(err.message)
      setPhase('intro')
    }
  }

  // Trong phòng không có màn bắt đầu: vào bài ngay (server cho tiếp tục lượt đang dở nên gọi hai lần cũng an toàn)
  useEffect(() => {
    if (roomCode) handleStart()
  }, [])

  // ---------- Thời gian từng câu (chỉ tính khi tab đang hiện) ----------
  const tick = useCallback(() => {
    const now = Date.now()
    const id = curQRef.current
    const last = tickRef.current
    tickRef.current = now
    if (!id || last == null || document.hidden) return
    const next = (spentRef.current[id] || 0) + Math.min(now - last, 5000)
    spentRef.current[id] = Math.min(next, MAX_SPENT_MS)
  }, [])

  // ---------- Lưu nháp ----------
  const flush = useCallback(async () => {
    if (savingRef.current || !attemptId || (dirtyRef.current.size === 0 && dirtyConfRef.current.size === 0)) return
    savingRef.current = true
    const ids = [...dirtyRef.current]
    const confIds = [...dirtyConfRef.current]
    const patch = {}
    for (const id of ids) patch[id] = answersRef.current[id] ?? null
    const confPatch = {}
    for (const id of confIds) confPatch[id] = confidenceRef.current[id] ?? null
    tick()
    const spentPatch = {}
    for (const [id, ms] of Object.entries(spentRef.current)) if (spentSentRef.current[id] !== ms) spentPatch[id] = ms
    dirtyRef.current.clear()
    dirtyConfRef.current.clear()
    setSaveState('saving')
    try {
      await saveAttemptAnswers(await getToken(), attemptId, patch, confPatch, spentPatch)
      Object.assign(spentSentRef.current, spentPatch)
      setSaveState(dirtyRef.current.size || dirtyConfRef.current.size ? 'dirty' : 'saved')
      setSavedAt(new Date())
    } catch (err) {
      ids.forEach((id) => dirtyRef.current.add(id))
      confIds.forEach((id) => dirtyConfRef.current.add(id))
      if (err.code === 'time-up' || err.code === 'already-submitted' || err.code === 'room-ended') {
        finishRef.current?.()
      } else {
        setSaveState('error')
      }
    } finally {
      savingRef.current = false
    }
  }, [attemptId, getToken, tick])

  function setAnswer(id, value) {
    answersRef.current = { ...answersRef.current, [id]: value }
    setAnswers(answersRef.current)
    dirtyRef.current.add(id)
    if (!isAnswered(value) && confidenceRef.current[id]) {
      const rest = { ...confidenceRef.current }
      delete rest[id]
      confidenceRef.current = rest
      setConfidence(rest)
    }
    setSaveState('dirty')
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS)
  }

  function setLevel(id, level) {
    const next = { ...confidenceRef.current }
    if (level) next[id] = level
    else delete next[id]
    confidenceRef.current = next
    setConfidence(next)
    dirtyConfRef.current.add(id)
    setSaveState('dirty')
    clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(flush, SAVE_DEBOUNCE_MS)
  }

  // Thử lại định kỳ: nếu lần lưu trước lỗi (mất mạng) thì tự lưu lại khi có mạng
  useEffect(() => {
    if (phase !== 'running') return
    const t = setInterval(flush, SAVE_RETRY_MS)
    const onOnline = () => flush()
    window.addEventListener('online', onOnline)
    return () => {
      clearInterval(t)
      clearTimeout(saveTimerRef.current)
      window.removeEventListener('online', onOnline)
    }
  }, [phase, flush])

  // ---------- Nộp bài ----------
  const finish = useCallback(
    async (auto = false) => {
      if (finishingRef.current || !attemptId) return
      finishingRef.current = true
      clearTimeout(saveTimerRef.current)
      setConfirming(false)
      setError('')
      setPhase('submitting')
      try {
        const token = await getToken()
        const final = {}
        for (const [id, v] of Object.entries(answersRef.current)) if (isAnswered(v)) final[id] = v
        const finalConf = {}
        for (const id of Object.keys(final)) finalConf[id] = confidenceRef.current[id] ?? null
        tick()
        try {
          await submitAttempt(token, attemptId, final, finalConf, { ...spentRef.current })
        } catch (err) {
          // Hết giờ hoặc đã nộp: bài đã được chốt ở server, cứ lấy kết quả
          if (err.code !== 'time-up' && err.code !== 'already-submitted') throw err
        }
        const res = await getAttemptResult(token, attemptId)
        setResult(res)
        setPhase('done')
      } catch (err) {
        finishingRef.current = false
        if (auto) autoFailedRef.current = true // không tự nộp lại liên tục khi mất mạng; để người làm bấm thử lại
        setError(`${err.message}. Câu trả lời của bạn vẫn còn trên màn hình, hãy kiểm tra mạng rồi bấm nộp lại.`)
        setPhase('running')
      }
    },
    [attemptId, getToken, tick]
  )

  useEffect(() => {
    finishRef.current = () => finish(true)
  }, [finish])

  const currentId = questions.length ? questions[Math.min(index, questions.length - 1)].id : null
  useEffect(() => {
    if (phase !== 'running') return
    curQRef.current = currentId
    tickRef.current = Date.now()
    const t = setInterval(tick, 1000)
    return () => {
      clearInterval(t)
      tick()
    }
  }, [phase, currentId, tick])

  // ---------- Đồng hồ ----------
  useEffect(() => {
    if (phase !== 'running') return
    const t = setInterval(() => setNow(Date.now() + offsetRef.current), 1000)
    return () => clearInterval(t)
  }, [phase])

  const remainingMs = deadlineMs == null ? null : deadlineMs - now
  useEffect(() => {
    if (phase === 'running' && remainingMs != null && remainingMs <= 0 && !autoFailedRef.current) finish(true)
  }, [phase, remainingMs, finish])

  // Trong phòng: phòng kết thúc thì nộp ngay (tin từ WebSocket); còn hỏi server định kỳ làm dự phòng, thưa hơn khi WebSocket đang nối
  useEffect(() => {
    if (roomEnded && phase === 'running') finishRef.current?.()
  }, [roomEnded, phase])

  useEffect(() => {
    if (!roomCode || phase !== 'running' || !attemptId) return
    const t = setInterval(async () => {
      try {
        const res = await getAttempt(await getToken(), attemptId)
        if (res.attempt.status === 'submitted') finishRef.current?.()
      } catch {
        // mất mạng: lần sau thử lại
      }
    }, live ? 30000 : 5000)
    return () => clearInterval(t)
  }, [roomCode, phase, attemptId, getToken, live])

  // ---------- Ghi nhận chuyển tab (đã báo trước ở màn bắt đầu và dòng nhắc khi làm) ----------
  useEffect(() => {
    if (phase !== 'running' || !attemptId) return
    const send = async (type) => logAttemptEvent(await getToken(), attemptId, type)
    const onVisibility = () => {
      send(document.hidden ? 'tab_hidden' : 'tab_visible')
      if (!document.hidden) flush()
    }
    const onBlur = () => !document.hidden && send('window_blur')
    const onFocus = () => !document.hidden && send('window_focus')
    const onCopy = () => send('copy')
    const onPaste = () => send('paste')
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('blur', onBlur)
    window.addEventListener('focus', onFocus)
    document.addEventListener('copy', onCopy)
    document.addEventListener('paste', onPaste)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('blur', onBlur)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('copy', onCopy)
      document.removeEventListener('paste', onPaste)
    }
  }, [phase, attemptId, getToken, flush])

  // Cảnh báo khi đóng tab giữa chừng
  useEffect(() => {
    if (phase !== 'running') return
    const onBeforeUnload = (e) => {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [phase])

  async function handleLeave() {
    await flush()
    onExit()
  }

  // ---------- Giao diện ----------
  if (phase === 'done' && result) {
    return <AttemptResult res={result} onExit={onExit} onRetry={onRetry} exitLabel={exitLabel} onCreateAccount={onCreateAccount} />
  }

  if (roomCode && (phase === 'intro' || phase === 'starting')) {
    if (!error) {
      return (
        <section className="card empty" aria-live="polite">
          <h2>Đang vào bài...</h2>
        </section>
      )
    }
    return (
      <section className="card">
        <p className="msg msg-error" role="alert">
          {error}
        </p>
        <div className="doc-actions">
          <button className="btn btn-primary" onClick={handleStart}>
            Thử lại
          </button>
          <button className="btn btn-secondary" onClick={onExit}>
            {exitLabel || 'Về danh sách quiz'}
          </button>
        </div>
      </section>
    )
  }

  if (phase === 'intro' || phase === 'starting') {
    const timed = Boolean(quiz.settings?.timeLimitMinutes)
    return (
      <>
        <section>
          <button className="btn btn-secondary" onClick={onExit}>
            <Icon name="back" size={18} /> Danh sách quiz
          </button>
          <h1>{quiz.title}</h1>
          {quiz.description && <p className="hint">{quiz.description}</p>}
        </section>

        <section className="card">
          <div className="quiz-meta">
            <span className="chip">{quiz.questionCount} câu</span>
            <span className="chip">{settingsText(quiz.settings)}</span>
          </div>
          <ul className="attempt-rules">
            <li>Bài được lưu tự động. Mất mạng hay tải lại trang thì mở quiz và bấm Bắt đầu để làm tiếp lượt đang dở.</li>
            {timed && <li>Thời gian tính từ lúc bấm Bắt đầu và chạy theo đồng hồ của máy chủ. Hết giờ, bài tự động nộp.</li>}
            <li>
              Hệ thống ghi nhận khi bạn chuyển tab, rời khỏi trình duyệt, sao chép hoặc dán trong lúc làm bài. Chỉ ghi nhận, bài không bị khóa.
            </li>
            <li>Đáp án đúng chỉ hiện sau khi bạn nộp bài.</li>
            <li>Với mỗi câu, bạn có thể đánh dấu mức tự tin (chắc chắn, phân vân, đoán). Không bắt buộc, dùng để gợi ý phần cần ôn.</li>
          </ul>
          {error && (
            <p className="msg msg-error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-primary" disabled={phase === 'starting'} onClick={handleStart}>
            {phase === 'starting' ? 'Đang mở bài...' : 'Bắt đầu làm bài'}
          </button>
        </section>
      </>
    )
  }

  if (phase === 'submitting') {
    return (
      <section className="card empty" aria-live="polite">
        <span className="tile-icon">
          <Icon name="check" size={26} />
        </span>
        <h2>Đang nộp bài và chấm điểm...</h2>
        <p className="hint">Vui lòng giữ nguyên trang này.</p>
      </section>
    )
  }

  // phase === 'running'
  if (questions.length === 0) {
    return (
      <section className="card empty">
        <h2>Không tải được đề</h2>
        <button className="btn btn-secondary" onClick={onExit}>
          Về danh sách quiz
        </button>
      </section>
    )
  }

  const q = questions[Math.min(index, questions.length - 1)]
  const answeredCount = questions.filter((x) => isAnswered(answers[x.id])).length
  const unanswered = questions.length - answeredCount
  const warn = remainingMs != null && remainingMs <= 60_000
  const saveText =
    saveState === 'saving'
      ? 'Đang lưu...'
      : saveState === 'error'
        ? 'Chưa lưu được, sẽ thử lại'
        : saveState === 'dirty'
          ? 'Chưa lưu'
          : saveState === 'saved' && savedAt
            ? `Đã lưu lúc ${timeText(savedAt)}`
            : session.resumed
              ? 'Đang làm tiếp lượt dở'
              : ''

  return (
    <>
      <div className="attempt-bar">
        <div className="attempt-bar-main">
          {remainingMs != null && (
            <span className={`attempt-clock${warn ? ' attempt-clock-warn' : ''}`} role="timer">
              <Icon name="clock" size={18} />
              {remainingMs <= 0 ? 'Hết giờ' : formatClock(remainingMs)}
            </span>
          )}
          <span className="attempt-progress">
            Đã trả lời {answeredCount}/{questions.length}
          </span>
        </div>
        <span className={`attempt-save${saveState === 'error' ? ' attempt-save-error' : ''}`} aria-live="polite">
          {saveText}
        </span>
      </div>

      {error && (
        <p className="msg msg-error" role="alert">
          {error}
        </p>
      )}

      <article className="card">
        <div className="q-top">
          <span className="badge">
            Câu {index + 1}/{questions.length}
          </span>
          <span className="badge">{TYPE_LABELS[q.type] || q.type}</span>
        </div>
        <p className="q-stem">
          <MathText text={q.stem} />
        </p>
        <QuestionInput key={q.id} q={q} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />
        {isAnswered(answers[q.id]) && q.type !== 'short' && (
          <div className="confidence" role="radiogroup" aria-label="Mức tự tin">
            <span className="confidence-label">Mức tự tin (không bắt buộc)</span>
            <div className="confidence-options">
              {CONFIDENCE_LEVELS.map((c) => (
                <button
                  key={c.value}
                  type="button"
                  role="radio"
                  aria-checked={confidence[q.id] === c.value}
                  className={`confidence-btn${confidence[q.id] === c.value ? ' confidence-btn-on' : ''}`}
                  onClick={() => setLevel(q.id, confidence[q.id] === c.value ? null : c.value)}
                >
                  {c.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {isAnswered(answers[q.id]) && q.type !== 'fill' && q.type !== 'short' && (
          <button className="btn-link attempt-clear" onClick={() => setAnswer(q.id, null)}>
            Bỏ chọn câu này
          </button>
        )}
      </article>

      <div className="attempt-actions">
        <button className="btn btn-secondary" disabled={index === 0} onClick={() => setIndex(index - 1)}>
          <Icon name="back" size={18} /> Câu trước
        </button>
        {index < questions.length - 1 ? (
          <button className="btn btn-primary" onClick={() => setIndex(index + 1)}>
            Câu sau
          </button>
        ) : (
          <button className="btn btn-primary" onClick={() => setConfirming(true)}>
            Nộp bài
          </button>
        )}
      </div>

      <section className="card">
        <h3>Danh sách câu</h3>
        <div className="attempt-nav" role="group" aria-label="Chuyển nhanh tới câu">
          {questions.map((x, i) => (
            <button
              key={x.id}
              className={`attempt-dot${isAnswered(answers[x.id]) ? ' attempt-dot-done' : ''}${i === index ? ' attempt-dot-cur' : ''}`}
              aria-label={`Câu ${i + 1}${isAnswered(answers[x.id]) ? ', đã trả lời' : ', chưa trả lời'}`}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => setIndex(i)}
            >
              {i + 1}
            </button>
          ))}
        </div>

        {confirming ? (
          <div className="attempt-confirm">
            <p>
              {unanswered > 0
                ? `Bạn còn ${unanswered} câu chưa trả lời. Nộp bài bây giờ?`
                : 'Bạn đã trả lời hết các câu. Nộp bài bây giờ?'}
            </p>
            <div className="doc-actions">
              <button className="btn btn-primary" onClick={() => finish(false)}>
                Xác nhận nộp bài
              </button>
              <button className="btn btn-secondary" onClick={() => setConfirming(false)}>
                Làm tiếp
              </button>
            </div>
          </div>
        ) : (
          <div className="doc-actions">
            <button className="btn btn-primary" onClick={() => setConfirming(true)}>
              Nộp bài
            </button>
            <button className="btn btn-secondary" onClick={handleLeave}>
              Rời bài, làm tiếp sau
            </button>
          </div>
        )}
        {remainingMs != null && <p className="hint">Rời bài thì đồng hồ vẫn chạy. Hết giờ, bài tự động nộp theo phần đã lưu.</p>}
        <p className="hint">Hệ thống ghi nhận chuyển tab, rời trình duyệt, sao chép và dán trong lúc làm bài.</p>
      </section>
    </>
  )
}

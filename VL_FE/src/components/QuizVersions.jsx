// Chức năng: lịch sử version đã publish của một quiz - xem nội dung từng version (không hiện đáp án) và sao chép version đó thành quiz mới.
import { useEffect, useState } from 'react'
import { forkQuiz, getQuizVersion, listQuizVersions } from '../services/api.js'
import { settingsText } from '../services/quizText.js'
import MathText from './MathText.jsx'
import Icon from './Icon.jsx'
import { TYPE_LABELS } from './QuestionCard.jsx'
import '../pages/Questions.css'
import '../pages/Quizzes.css'

const dateText = (iso) => (iso ? new Date(iso).toLocaleString('vi-VN') : '')

export default function QuizVersions({ getToken, quiz, onBack, onForked }) {
  const [versions, setVersions] = useState(null)
  const [open, setOpen] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await listQuizVersions(await getToken(), quiz.id)
        if (!cancelled) setVersions(res.versions)
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [getToken, quiz.id])

  async function toggleOpen(n) {
    if (open?.version === n) return setOpen(null)
    setBusy(true)
    setError('')
    try {
      const res = await getQuizVersion(await getToken(), quiz.id, n)
      setOpen(res.version)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function fork(n) {
    setBusy(true)
    setError('')
    try {
      const res = await forkQuiz(await getToken(), quiz.id, n)
      onForked(res.quiz.id)
    } catch (err) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <>
      <section>
        <button className="btn btn-secondary" onClick={onBack}>
          <Icon name="back" size={18} /> Danh sách quiz
        </button>
        <h1>Lịch sử version</h1>
        <p className="hint">{quiz.title}</p>
      </section>

      {error && (
        <p className="msg msg-error" role="alert">
          {error}
        </p>
      )}
      {versions === null && !error && <p className="hint">Đang tải...</p>}
      {versions && versions.length === 0 && (
        <section className="card empty">
          <h2>Chưa publish version nào</h2>
        </section>
      )}

      {versions?.map((v) => (
        <article key={v.version} className="card">
          <div className="quiz-meta">
            <span className="badge badge-ok">Version {v.version}</span>
            <span className="chip">{v.questionCount} câu</span>
            <span className="chip">{dateText(v.createdAt)}</span>
          </div>
          <h2 className="quiz-title">{v.title}</h2>
          <p className="hint">{settingsText(v.settings)}</p>

          {open?.version === v.version && (
            <>
              <p className="hint">Đáp án được giữ kín ở máy chủ nên không hiện ở đây.</p>
              {open.questions.map((q, i) => (
                <div key={q.id} className="version-q">
                  <div className="q-top">
                    <span className="badge">Câu {i + 1}</span>
                    <span className="badge">{TYPE_LABELS[q.type] || q.type}</span>
                  </div>
                  <p className="q-stem">
                    <MathText text={q.stem} />
                  </p>
                  {q.options.length > 0 && (
                    <ul className="q-options">
                      {q.options.map((opt, k) => (
                        <li key={k} className="q-option">
                          <MathText text={opt} />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              ))}
            </>
          )}

          <div className="doc-actions">
            <button className="btn btn-secondary" disabled={busy} onClick={() => toggleOpen(v.version)}>
              {open?.version === v.version ? 'Ẩn nội dung' : 'Xem nội dung'}
            </button>
            <button className="btn btn-secondary" disabled={busy} onClick={() => fork(v.version)}>
              Sao chép thành quiz mới
            </button>
          </div>
        </article>
      ))}
    </>
  )
}

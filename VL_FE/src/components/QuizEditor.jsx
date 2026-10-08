// Chức năng: màn tạo/sửa bản nháp quiz - tiêu đề, cài đặt (thời gian, số lần làm, xáo trộn), chọn và sắp xếp câu hỏi đã duyệt, lưu nháp, lưu và publish.
import { useEffect, useMemo, useState } from 'react'
import { createQuiz, getQuiz, listQuestions, listTopics, publishQuiz, updateQuiz } from '../services/api.js'
import MathText from './MathText.jsx'
import Icon from './Icon.jsx'
import { TYPE_LABELS } from './QuestionCard.jsx'
import '../pages/Questions.css'
import '../pages/Quizzes.css'

const MAX_QUESTIONS = 100
const toNum = (v) => (v === '' ? null : Number(v))
const numText = (n) => (n == null ? '' : String(n))

function buildPayload(f) {
  return {
    title: f.title.trim(),
    description: f.description.trim(),
    questionIds: f.selected,
    settings: {
      timeLimitMinutes: toNum(f.timeLimit),
      maxAttempts: toNum(f.attempts),
      shuffleQuestions: f.shuffleQuestions,
      shuffleOptions: f.shuffleOptions,
    },
  }
}

function intInRange(v, min, max) {
  if (v === '') return true
  const n = Number(v)
  return Number.isInteger(n) && n >= min && n <= max
}

export default function QuizEditor({ getToken, quizId, onBack }) {
  const [id, setId] = useState(quizId)
  const [loading, setLoading] = useState(Boolean(quizId))
  const [meta, setMeta] = useState(null)
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [timeLimit, setTimeLimit] = useState('')
  const [attempts, setAttempts] = useState('')
  const [shuffleQuestions, setShuffleQuestions] = useState(true)
  const [shuffleOptions, setShuffleOptions] = useState(true)
  const [selected, setSelected] = useState([])
  const [bank, setBank] = useState([])
  const [topics, setTopics] = useState([])
  const [known, setKnown] = useState({})
  const [topicFilter, setTopicFilter] = useState('')
  const [search, setSearch] = useState('')
  const [saved, setSaved] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const token = await getToken()
        const [qs, ts, detail] = await Promise.all([
          listQuestions(token, { reviewStatus: 'approved' }),
          listTopics(token),
          quizId ? getQuiz(token, quizId) : null,
        ])
        if (cancelled) return
        setBank(qs.questions)
        setTopics(ts.topics)
        if (detail) {
          const q = detail.quiz
          const ids = q.questions.map((x) => x.id)
          const form = {
            title: q.title,
            description: q.description || '',
            selected: ids,
            timeLimit: numText(q.settings.timeLimitMinutes),
            attempts: numText(q.settings.maxAttempts),
            shuffleQuestions: q.settings.shuffleQuestions,
            shuffleOptions: q.settings.shuffleOptions,
          }
          setTitle(form.title)
          setDescription(form.description)
          setSelected(ids)
          setTimeLimit(form.timeLimit)
          setAttempts(form.attempts)
          setShuffleQuestions(form.shuffleQuestions)
          setShuffleOptions(form.shuffleOptions)
          setKnown(Object.fromEntries(q.questions.map((x) => [x.id, x])))
          setMeta({ currentVersion: q.currentVersion, hasUnpublishedChanges: q.hasUnpublishedChanges })
          setSaved(JSON.stringify(buildPayload(form)))
        }
      } catch (err) {
        if (!cancelled) setError(err.message)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [getToken, quizId])

  const form = { title, description, selected, timeLimit, attempts, shuffleQuestions, shuffleOptions }
  const dirty = !id || JSON.stringify(buildPayload(form)) !== saved

  const topicLabels = useMemo(
    () => Object.fromEntries(topics.map((t) => [t.id, `${t.subject} › ${t.chapter} › ${t.name}`])),
    [topics]
  )
  const byId = useMemo(() => ({ ...known, ...Object.fromEntries(bank.map((q) => [q.id, q])) }), [known, bank])

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return bank.filter((q) => (!topicFilter || q.topicId === topicFilter) && (!needle || q.stem.toLowerCase().includes(needle)))
  }, [bank, topicFilter, search])

  const hasProblem = selected.some((qid) => {
    const q = byId[qid]
    return !q || q.missing || q.reviewStatus !== 'approved'
  })
  const settingsOk = intInRange(timeLimit, 1, 300) && intInRange(attempts, 1, 20)
  const canSave = title.trim() && settingsOk && !hasProblem && !busy

  function toggle(qid) {
    setSelected((cur) => (cur.includes(qid) ? cur.filter((x) => x !== qid) : cur.length >= MAX_QUESTIONS ? cur : [...cur, qid]))
  }

  function addShown() {
    setSelected((cur) => {
      const next = [...cur]
      for (const q of shown) if (!next.includes(q.id) && next.length < MAX_QUESTIONS) next.push(q.id)
      return next
    })
  }

  function move(i, delta) {
    setSelected((cur) => {
      const j = i + delta
      if (j < 0 || j >= cur.length) return cur
      const next = [...cur]
      const tmp = next[i]
      next[i] = next[j]
      next[j] = tmp
      return next
    })
  }

  async function persist() {
    const token = await getToken()
    const payload = buildPayload(form)
    const res = id ? await updateQuiz(token, id, payload) : await createQuiz(token, payload)
    setId(res.quiz.id)
    setMeta({ currentVersion: res.quiz.currentVersion, hasUnpublishedChanges: res.quiz.hasUnpublishedChanges })
    setSaved(JSON.stringify(payload))
    return res.quiz.id
  }

  async function run(action) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await action()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const handleSave = () =>
    run(async () => {
      await persist()
      setNotice('Đã lưu bản nháp.')
    })

  const handlePublish = () =>
    run(async () => {
      const qid = dirty ? await persist() : id
      const res = await publishQuiz(await getToken(), qid)
      setMeta({ currentVersion: res.quiz.currentVersion, hasUnpublishedChanges: res.quiz.hasUnpublishedChanges })
      setNotice(`Đã publish version ${res.version}.`)
    })

  if (loading) return <p className="hint">Đang tải quiz...</p>

  return (
    <>
      <section>
        <button className="btn btn-secondary" onClick={onBack}>
          <Icon name="back" size={18} /> Danh sách quiz
        </button>
        <h1>{id ? 'Sửa quiz' : 'Tạo quiz mới'}</h1>
        {meta && (
          <div className="quiz-meta">
            <span className={`badge ${meta.currentVersion ? 'badge-ok' : 'badge-draft'}`}>
              {meta.currentVersion ? `Đã publish version ${meta.currentVersion}` : 'Chưa publish'}
            </span>
            {meta.currentVersion > 0 && meta.hasUnpublishedChanges && <span className="chip">Có thay đổi chưa publish</span>}
          </div>
        )}
      </section>

      <section className="card">
        <label>
          Tên quiz
          <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} placeholder="Ví dụ: Kiểm tra 15 phút - Hàm số" />
        </label>
        <label>
          Mô tả (tùy chọn)
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </label>

        <div className="grid-2">
          <label>
            Thời gian làm bài (phút)
            <input type="number" inputMode="numeric" min={1} max={300} value={timeLimit} onChange={(e) => setTimeLimit(e.target.value)} placeholder="Không giới hạn" />
          </label>
          <label>
            Số lần làm tối đa
            <input type="number" inputMode="numeric" min={1} max={20} value={attempts} onChange={(e) => setAttempts(e.target.value)} placeholder="Không giới hạn" />
          </label>
        </div>
        {!settingsOk && (
          <p className="msg msg-error" role="alert">
            Thời gian từ 1 đến 300 phút, số lần làm từ 1 đến 20 (để trống là không giới hạn).
          </p>
        )}

        <label className="check-row">
          <input type="checkbox" checked={shuffleQuestions} onChange={(e) => setShuffleQuestions(e.target.checked)} />
          Xáo trộn thứ tự câu hỏi
        </label>
        <label className="check-row">
          <input type="checkbox" checked={shuffleOptions} onChange={(e) => setShuffleOptions(e.target.checked)} />
          Xáo trộn thứ tự đáp án
        </label>
      </section>

      <section className="card">
        <h2>Câu hỏi trong quiz ({selected.length}/{MAX_QUESTIONS})</h2>
        {selected.length === 0 ? (
          <p className="hint">Chưa chọn câu nào. Hãy thêm câu hỏi đã duyệt từ ngân hàng ở bên dưới.</p>
        ) : (
          <ol className="order-list">
            {selected.map((qid, i) => {
              const q = byId[qid]
              const exists = q && !q.missing
              const bad = !exists || q.reviewStatus !== 'approved'
              return (
                <li key={qid} className="order-row">
                  <span className="order-no">{i + 1}</span>
                  <span className="pick-body">
                    <span className="pick-stem">{exists ? <MathText text={q.stem} /> : 'Câu hỏi đã bị xóa'}</span>
                    {bad && <span className="pick-meta pick-warn">{exists ? 'Chưa duyệt' : 'Không còn trong ngân hàng'} · hãy bỏ khỏi quiz</span>}
                  </span>
                  <span className="order-actions">
                    <button type="button" className="btn btn-secondary" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Chuyển câu ${i + 1} lên`}>
                      ↑
                    </button>
                    <button type="button" className="btn btn-secondary" disabled={i === selected.length - 1} onClick={() => move(i, 1)} aria-label={`Chuyển câu ${i + 1} xuống`}>
                      ↓
                    </button>
                    <button type="button" className="btn btn-secondary" onClick={() => toggle(qid)} aria-label={`Bỏ câu ${i + 1} khỏi quiz`}>
                      Bỏ
                    </button>
                  </span>
                </li>
              )
            })}
          </ol>
        )}
      </section>

      <section className="card">
        <h2>Thêm từ ngân hàng câu hỏi</h2>
        <p className="hint">Chỉ hiện các câu đã duyệt. Câu nháp cần duyệt ở trang Câu hỏi trước.</p>
        <div className="grid-2">
          <label>
            Chủ đề
            <select value={topicFilter} onChange={(e) => setTopicFilter(e.target.value)}>
              <option value="">Tất cả</option>
              {topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {topicLabels[t.id]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tìm trong đề bài
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Gõ từ khóa..." />
          </label>
        </div>

        {bank.length === 0 ? (
          <p className="hint">Chưa có câu hỏi nào đã duyệt.</p>
        ) : shown.length === 0 ? (
          <p className="hint">Không có câu nào khớp bộ lọc.</p>
        ) : (
          <>
            <div className="doc-actions">
              <button type="button" className="btn btn-secondary" onClick={addShown}>
                Thêm tất cả {shown.length} câu đang hiện
              </button>
            </div>
            <div className="pick-list">
              {shown.map((q) => (
                <label key={q.id} className="check-row pick-row">
                  <input type="checkbox" checked={selected.includes(q.id)} onChange={() => toggle(q.id)} />
                  <span className="pick-body">
                    <span className="pick-stem">
                      <MathText text={q.stem} />
                    </span>
                    <span className="pick-meta">
                      {TYPE_LABELS[q.type] || q.type}
                      {topicLabels[q.topicId] ? ` · ${topicLabels[q.topicId]}` : ''}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </>
        )}
      </section>

      <section className="card">
        {hasProblem && (
          <p className="msg msg-error" role="alert">
            Có câu đã bị xóa hoặc chưa duyệt. Hãy bỏ chúng khỏi quiz trước khi lưu.
          </p>
        )}
        {error && (
          <p className="msg msg-error" role="alert">
            {error}
          </p>
        )}
        {notice && <p className="msg-ok">{notice}</p>}
        <div className="doc-actions">
          <button className="btn btn-secondary" disabled={!canSave || !dirty} onClick={handleSave}>
            {busy ? 'Đang xử lý...' : 'Lưu nháp'}
          </button>
          <button className="btn btn-primary" disabled={!canSave || selected.length === 0 || (!dirty && meta && !meta.hasUnpublishedChanges && meta.currentVersion > 0)} onClick={handlePublish}>
            {busy ? 'Đang xử lý...' : dirty ? 'Lưu và publish' : 'Publish'}
          </button>
        </div>
        <p className="hint">Publish tạo một version cố định. Sửa tiếp sau đó sẽ tạo version mới, người đã làm bài không bị ảnh hưởng.</p>
      </section>
    </>
  )
}

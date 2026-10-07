// Chức năng: form tạo câu hỏi bằng AI từ một tài liệu - chọn tài liệu, chủ đề (Môn > Chương > Chủ đề), số câu, dạng câu, khoảng trang;
// theo dõi tiến độ job; hiện AI credits còn lại. Khi job xong gọi onDone(jobId, result) để màn duyệt tải câu hỏi mới.
import { useEffect, useState } from 'react'
import { createTopic, generateQuestions, getJob } from '../services/api.js'
import { TYPE_LABELS } from './QuestionCard.jsx'
import { creditErrorText, formatResetAt, resetDate } from '../services/credits.js'
import { useCredits } from '../hooks/useCredits.jsx'
import CreditCard from './CreditMeter.jsx'
import '../pages/Questions.css'

const POLL_MS = 3000
const NEW_TOPIC = '__new__'
const REJECT_TEXT = {
  'invalid-schema': 'sai định dạng',
  'missing-answer': 'thiếu đáp án',
  'duplicate-options': 'trùng lựa chọn',
  'invalid-answer': 'đáp án không hợp lệ',
  'bad-blank': 'sai chỗ trống',
  'type-not-allowed': 'sai dạng câu',
  'unknown-chunk': 'sai nguồn',
  'duplicate-question': 'trùng đề',
}

function jobText(job) {
  if (job.status === 'queued') return 'Đang chờ đến lượt xử lý...'
  if (job.status === 'running') {
    return job.progress?.total ? `AI đang soạn câu hỏi (lô ${job.progress.done}/${job.progress.total})...` : 'AI đang soạn câu hỏi...'
  }
  return ''
}

function rejectedText(rejected) {
  const parts = Object.entries(rejected || {}).map(([k, n]) => `${n} ${REJECT_TEXT[k] || k}`)
  return parts.length ? ` Đã loại ${parts.join(', ')}.` : ''
}

export default function QuestionGenerator({ getToken, docs, topics, onTopicCreated, onDone }) {
  const readyDocs = docs.filter((d) => d.status === 'ready')
  const [documentId, setDocumentId] = useState('')
  const [topicId, setTopicId] = useState('')
  const [newTopic, setNewTopic] = useState({ subject: '', chapter: '', name: '' })
  const [count, setCount] = useState(10)
  const [types, setTypes] = useState(['single'])
  const [pageFrom, setPageFrom] = useState('')
  const [pageTo, setPageTo] = useState('')
  const { credits, reload: loadCredits } = useCredits()
  const [job, setJob] = useState(null) // { id, status, progress, error, result }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const jobId = job?.id
  const active = job && (job.status === 'queued' || job.status === 'running')

  // Hỏi tiến độ job đang chạy (dừng khi xong hoặc lỗi)
  useEffect(() => {
    if (!jobId || !active) return
    const timer = setInterval(async () => {
      if (document.hidden) return
      try {
        const fresh = (await getJob(await getToken(), jobId)).job
        setJob(fresh)
        if (fresh.status === 'done') {
          loadCredits()
          onDone(fresh.id, fresh.result)
        } else if (fresh.status === 'failed') {
          loadCredits() // job lỗi => credits được hoàn
        }
      } catch {
        // thử lại ở lần hỏi sau
      }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [jobId, active, getToken, loadCredits, onDone])

  function toggleType(t) {
    setTypes((cur) => (cur.includes(t) ? cur.filter((x) => x !== t) : [...cur, t]))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (types.length === 0) return setError('Hãy chọn ít nhất một dạng câu hỏi.')

    setBusy(true)
    try {
      const token = await getToken()
      let tid = topicId
      if (tid === NEW_TOPIC) {
        const res = await createTopic(token, {
          subject: newTopic.subject,
          chapter: newTopic.chapter,
          name: newTopic.name,
        })
        tid = res.topic.id
        onTopicCreated(res.topic)
        setTopicId(tid)
      }

      const body = { documentId, topicId: tid, count: Number(count), types }
      if (pageFrom) body.pageFrom = Number(pageFrom)
      if (pageTo) body.pageTo = Number(pageTo)

      const res = await generateQuestions(token, body)
      setJob({ id: res.jobId, status: 'queued', progress: null, error: null, result: null })
      loadCredits()
    } catch (err) {
      setError(creditErrorText(err))
      if (err.code === 'quota-credits') loadCredits() // hiện thẻ hết credits kèm đếm ngược
    } finally {
      setBusy(false)
    }
  }

  const formOk = documentId && topicId && (topicId !== NEW_TOPIC || (newTopic.subject.trim() && newTopic.chapter.trim() && newTopic.name.trim()))
  const outOfCredits = credits && credits.remaining <= 0
  const notEnough = credits && !outOfCredits && Number(count) > credits.remaining

  return (
    <section className="card">
      <h2>Tạo câu hỏi bằng AI</h2>

      <CreditCard compact note="1 credit = 1 câu hỏi" />

      {readyDocs.length === 0 ? (
        <p className="hint">Chưa có tài liệu nào ở trạng thái "Sẵn sàng". Hãy tải tài liệu lên ở mục Tài liệu trước.</p>
      ) : (
        <form className="card" onSubmit={handleSubmit}>
          <label>
            Tài liệu
            <select value={documentId} onChange={(e) => setDocumentId(e.target.value)} required>
              <option value="">Chọn tài liệu...</option>
              {readyDocs.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>

          <label>
            Chủ đề (Môn › Chương › Chủ đề)
            <select value={topicId} onChange={(e) => setTopicId(e.target.value)} required>
              <option value="">Chọn chủ đề...</option>
              {topics.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.subject} › {t.chapter} › {t.name}
                </option>
              ))}
              <option value={NEW_TOPIC}>+ Tạo chủ đề mới</option>
            </select>
          </label>

          {topicId === NEW_TOPIC && (
            <div className="card">
              {[
                ['subject', 'Môn', 'Ví dụ: Toán 10'],
                ['chapter', 'Chương', 'Ví dụ: Hàm số bậc hai'],
                ['name', 'Chủ đề', 'Ví dụ: Đỉnh và trục đối xứng'],
              ].map(([key, label, ph]) => (
                <label key={key}>
                  {label}
                  <input
                    value={newTopic[key]}
                    onChange={(e) => setNewTopic((cur) => ({ ...cur, [key]: e.target.value }))}
                    placeholder={ph}
                    maxLength={key === 'subject' ? 60 : 80}
                    required
                  />
                </label>
              ))}
            </div>
          )}

          <label>
            Số câu (tối đa theo gói của bạn)
            <input type="number" inputMode="numeric" min={1} max={100} value={count} onChange={(e) => setCount(e.target.value)} required />
          </label>

          <fieldset className="check-list" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="hint">Dạng câu hỏi</legend>
            {Object.entries(TYPE_LABELS).map(([t, label]) => (
              <label key={t} className="check-row">
                <input type="checkbox" checked={types.includes(t)} onChange={() => toggleType(t)} />
                {label}
              </label>
            ))}
          </fieldset>

          <div className="grid-2">
            <label>
              Từ trang (tùy chọn)
              <input type="number" inputMode="numeric" min={1} value={pageFrom} onChange={(e) => setPageFrom(e.target.value)} />
            </label>
            <label>
              Đến trang (tùy chọn)
              <input type="number" inputMode="numeric" min={1} value={pageTo} onChange={(e) => setPageTo(e.target.value)} />
            </label>
          </div>

          {notEnough && (
            <p className="msg msg-error" role="alert">
              Chỉ còn {credits.remaining} credits, hãy giảm số câu xuống {credits.remaining} hoặc ít hơn (credits làm mới lúc{' '}
              {formatResetAt(resetDate(credits))}).
            </p>
          )}

          {error && (
            <p className="msg msg-error" role="alert">
              {error}
            </p>
          )}

          <button className="btn btn-primary" type="submit" disabled={busy || active || !formOk || outOfCredits || notEnough}>
            {busy ? 'Đang gửi...' : active ? 'AI đang làm việc...' : 'Tạo câu hỏi'}
          </button>
        </form>
      )}

      {job && (
        <div className="upload-state" role="status">
          {active && (
            <>
              <p className="hint">{jobText(job)}</p>
              <div className="bar" aria-hidden="true">
                <span style={{ width: job.progress?.total ? `${(job.progress.done / job.progress.total) * 100}%` : '8%' }} />
              </div>
            </>
          )}
          {job.status === 'done' && (
            <p className="msg-ok">
              Đã tạo {job.result?.saved ?? 0}/{job.result?.requested ?? 0} câu (đang ở trạng thái nháp, hãy duyệt bên dưới).
              {rejectedText(job.result?.rejected)}
            </p>
          )}
          {job.status === 'failed' && (
            <p className="msg msg-error" role="alert">
              {job.error || 'Tạo câu hỏi thất bại.'} Credits đã được hoàn lại.
            </p>
          )}
        </div>
      )}
    </section>
  )
}

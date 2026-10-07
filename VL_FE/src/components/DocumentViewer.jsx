// Chức năng: xem lại nội dung đã trích của một tài liệu, từng trang một (trước/sau, nhảy tới trang),
// có thể mở sẵn đúng trang (initialPage, dùng cho nút "Xem nguồn"), kèm tóm tắt và hỏi đáp tài liệu bằng AI.
import { useEffect, useState } from 'react'
import { askDocument, createSummary, getDocumentPage, getSummary } from '../services/api.js'
import Icon from './Icon.jsx'
import MathText from './MathText.jsx'
import { creditErrorText } from '../services/credits.js'
import '../pages/Questions.css'

function clampPage(n, total) {
  return Math.min(Math.max(Math.trunc(Number(n)) || 1, 1), total)
}

// Chip bấm để nhảy tới trang nguồn
function PageLink({ page, onGo }) {
  if (!page) return null
  return (
    <button type="button" className="page-link" onClick={() => onGo(page)}>
      Trang {page}
    </button>
  )
}

function SummaryPanel({ doc, getToken, onGo }) {
  const [summary, setSummary] = useState(undefined) // undefined: đang tải, null: chưa có
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    getToken()
      .then((token) => getSummary(token, doc.id))
      .then((res) => !cancelled && setSummary(res.summary))
      .catch(() => !cancelled && setSummary(null))
    return () => {
      cancelled = true
    }
  }, [doc.id, getToken])

  async function create(force) {
    setBusy(true)
    setError('')
    try {
      const res = await createSummary(await getToken(), doc.id, force)
      setSummary(res.summary)
    } catch (err) {
      setError(creditErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>Tóm tắt</h2>
      {summary === undefined && <p className="hint">Đang tải...</p>}

      {summary === null && (
        <>
          <p className="hint">Chưa có bản tóm tắt. Tạo tóm tắt sẽ tốn AI credits.</p>
          <button className="btn btn-primary" disabled={busy} onClick={() => create(false)}>
            {busy ? 'AI đang tóm tắt...' : 'Tóm tắt tài liệu'}
          </button>
        </>
      )}

      {summary && (
        <>
          <p>
            <MathText text={summary.overview} />
          </p>
          <ul className="ai-points">
            {(summary.points || []).map((p, i) => (
              <li key={p.chunkId || i}>
                <PageLink page={p.pageNumber} onGo={onGo} />
                <span>
                  <MathText text={p.text} />
                </span>
              </li>
            ))}
          </ul>
          <button className="btn btn-secondary" disabled={busy} onClick={() => create(true)}>
            {busy ? 'AI đang tóm tắt...' : 'Tóm tắt lại (tốn credits)'}
          </button>
        </>
      )}

      {error && (
        <p className="msg msg-error" role="alert">
          {error}
        </p>
      )}
    </section>
  )
}

function AskPanel({ doc, getToken, onGo }) {
  const [question, setQuestion] = useState('')
  const [result, setResult] = useState(null) // { found, answer, sources }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function submit(e) {
    e.preventDefault()
    const q = question.trim()
    if (!q) return
    setBusy(true)
    setError('')
    setResult(null)
    try {
      setResult(await askDocument(await getToken(), doc.id, q))
    } catch (err) {
      setError(creditErrorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>Hỏi đáp tài liệu</h2>
      <p className="hint">AI chỉ trả lời từ nội dung tài liệu này và ghi rõ trang nguồn.</p>
      <form className="ask-form" onSubmit={submit}>
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={300}
          placeholder="Ví dụ: Định nghĩa hàm số bậc hai là gì?"
          aria-label="Câu hỏi về tài liệu"
        />
        <button className="btn btn-primary" type="submit" disabled={busy || !question.trim()}>
          {busy ? 'AI đang tìm trong tài liệu...' : 'Hỏi'}
        </button>
      </form>

      {error && (
        <p className="msg msg-error" role="alert">
          {error}
        </p>
      )}

      {result && !result.found && <p className="hint">Không tìm thấy câu trả lời trong tài liệu này.</p>}

      {result && result.found && (
        <>
          <p>
            <MathText text={result.answer} />
          </p>
          {(result.sources || []).map((s) => (
            <div key={s.chunkId} className="ask-source">
              <PageLink page={s.pageNumber} onGo={onGo} />
              <div>
                <MathText text={s.text} />
              </div>
            </div>
          ))}
        </>
      )}
    </section>
  )
}

export default function DocumentViewer({ doc, getToken, onClose, initialPage = 1 }) {
  const total = doc.pageCount || 1
  const start = clampPage(initialPage, total)
  const [page, setPage] = useState(start)
  const [jump, setJump] = useState(String(start))
  const [text, setText] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    getToken()
      .then((token) => getDocumentPage(token, doc.id, page))
      .then((data) => {
        if (cancelled) return
        setText(data.page.text)
        setLoading(false)
      })
      .catch((err) => {
        if (cancelled) return
        setError(err.message)
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [doc.id, page, getToken])

  function goTo(n) {
    const next = clampPage(n, total)
    setPage(next)
    setJump(String(next))
    window.scrollTo(0, 0)
  }

  function handleJump(e) {
    e.preventDefault()
    goTo(jump)
  }

  const isPdf = doc.mimeType === 'application/pdf'
  const ready = doc.status === 'ready' || doc.status === undefined

  return (
    <>
      <div className="viewer-head">
        <button className="icon-btn" onClick={onClose} aria-label="Quay lại">
          <Icon name="back" size={22} />
        </button>
        <div className="doc-title">
          <h2>{doc.name}</h2>
          <p className="hint">
            Trang {page}/{total}
            {!isPdf && ' · trang ước lượng'}
          </p>
        </div>
      </div>

      <section className="card">
        {loading && <p className="hint">Đang tải trang...</p>}
        {error && (
          <p className="msg msg-error" role="alert">
            {error}
          </p>
        )}
        {!loading && !error && (text ? <p className="page-text">{text}</p> : <p className="hint">Trang này không có chữ.</p>)}
      </section>

      <form className="viewer-nav" onSubmit={handleJump}>
        <button type="button" className="btn btn-secondary" disabled={page <= 1} onClick={() => goTo(page - 1)}>
          Trang trước
        </button>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          max={total}
          value={jump}
          onChange={(e) => setJump(e.target.value)}
          aria-label="Đi tới trang"
        />
        <button type="button" className="btn btn-secondary" disabled={page >= total} onClick={() => goTo(page + 1)}>
          Trang sau
        </button>
      </form>

      {ready && (
        <>
          <SummaryPanel doc={doc} getToken={getToken} onGo={goTo} />
          <AskPanel doc={doc} getToken={getToken} onGo={goTo} />
        </>
      )}
    </>
  )
}

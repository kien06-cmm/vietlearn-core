// Chức năng: xem lại nội dung đã trích của một tài liệu, từng trang một (trước/sau, nhảy tới trang).
import { useEffect, useState } from 'react'
import { getDocumentPage } from '../services/api.js'
import Icon from './Icon.jsx'

export default function DocumentViewer({ doc, getToken, onClose }) {
  const total = doc.pageCount || 1
  const [page, setPage] = useState(1)
  const [jump, setJump] = useState('1')
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
    const next = Math.min(Math.max(Math.trunc(Number(n)) || 1, 1), total)
    setPage(next)
    setJump(String(next))
  }

  function handleJump(e) {
    e.preventDefault()
    goTo(jump)
  }

  const isPdf = doc.mimeType === 'application/pdf'

  return (
    <>
      <div className="viewer-head">
        <button className="icon-btn" onClick={onClose} aria-label="Quay lại thư viện">
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
    </>
  )
}

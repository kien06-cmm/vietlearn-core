// Chức năng: thẻ một tài liệu trong thư viện - trạng thái/tiến độ xử lý, ghim, sửa tên/thư mục/tag, xóa, mở xem từng trang.
import { useState } from 'react'
import Icon from './Icon.jsx'

function formatSize(bytes) {
  if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1048576).toFixed(1)} MB`
}

function statusText(d) {
  switch (d.status) {
    case 'uploading':
      return 'Chưa hoàn tất tải lên'
    case 'queued':
      return 'Đang chờ xử lý...'
    case 'processing':
      return d.progress?.total ? `Đang phân tích trang ${d.progress.done}/${d.progress.total}` : 'Đang phân tích...'
    case 'ready':
      return d.pageCount ? `Sẵn sàng · ${d.pageCount} trang` : 'Sẵn sàng'
    case 'failed':
      return d.error || 'Xử lý thất bại'
    default:
      return d.status
  }
}

function parseTags(text) {
  return [...new Set(text.split(',').map((t) => t.trim()).filter(Boolean))].slice(0, 10)
}

export default function DocumentCard({ doc, onOpen, onOriginal, onPatch, onDelete }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(doc.name)
  const [folder, setFolder] = useState(doc.folder)
  const [tagText, setTagText] = useState(doc.tags.join(', '))
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const percent = doc.status === 'processing' && doc.progress?.total ? (doc.progress.done / doc.progress.total) * 100 : null
  const ext = doc.name.split('.').pop().toUpperCase()

  async function run(action) {
    setBusy(true)
    setMsg('')
    try {
      await action()
      return true
    } catch (err) {
      setMsg(err.message)
      return false
    } finally {
      setBusy(false)
    }
  }

  async function handleSave(e) {
    e.preventDefault()
    const changes = {}
    if (name.trim() && name.trim() !== doc.name) changes.name = name.trim()
    if (folder.trim() !== doc.folder) changes.folder = folder.trim()
    const tags = parseTags(tagText)
    if (tags.join('|') !== doc.tags.join('|')) changes.tags = tags
    if (Object.keys(changes).length === 0) return setEditing(false)
    if (await run(() => onPatch(doc.id, changes))) setEditing(false)
  }

  return (
    <article className="card doc">
      <div className="doc-head">
        <span className="tile-icon">
          <Icon name="file" size={22} />
        </span>
        <div className="doc-title">
          <h3>{doc.name}</h3>
          <p className="hint">
            {ext} · {formatSize(doc.sizeBytes)}
            {doc.folder && ` · ${doc.folder}`}
          </p>
        </div>
        <button
          className="icon-btn"
          aria-label={doc.pinned ? 'Bỏ ghim' : 'Ghim'}
          aria-pressed={doc.pinned}
          disabled={busy}
          onClick={() => run(() => onPatch(doc.id, { pinned: !doc.pinned }))}
        >
          <Icon name="pin" size={20} />
        </button>
      </div>

      <p className={`doc-status doc-status-${doc.status}`}>{statusText(doc)}</p>
      {percent !== null && (
        <div className="bar" aria-hidden="true">
          <span style={{ width: `${percent}%` }} />
        </div>
      )}

      {doc.tags.length > 0 && (
        <div className="chips">
          {doc.tags.map((t) => (
            <span key={t} className="chip">
              {t}
            </span>
          ))}
        </div>
      )}

      {msg && (
        <p className="msg msg-error" role="alert">
          {msg}
        </p>
      )}

      {editing ? (
        <form className="card" onSubmit={handleSave}>
          <label>
            Tên tài liệu
            <input value={name} onChange={(e) => setName(e.target.value)} maxLength={200} required />
          </label>
          <label>
            Thư mục
            <input value={folder} onChange={(e) => setFolder(e.target.value)} maxLength={60} placeholder="Ví dụ: Toán 10" />
          </label>
          <label>
            Tag (cách nhau bằng dấu phẩy, tối đa 10)
            <input value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="giữa kỳ, chương 2" />
          </label>
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Đang lưu...' : 'Lưu'}
          </button>
          <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => setEditing(false)}>
            Hủy
          </button>
        </form>
      ) : confirming ? (
        <div className="doc-actions">
          <button className="btn btn-danger" disabled={busy} onClick={() => run(() => onDelete(doc.id))}>
            {busy ? 'Đang xóa...' : 'Xác nhận xóa'}
          </button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => setConfirming(false)}>
            Hủy
          </button>
        </div>
      ) : (
        <div className="doc-actions">
          {doc.status === 'ready' && (
            <button className="btn btn-primary" onClick={() => onOpen(doc)}>
              Xem chữ từng trang
            </button>
          )}
          {doc.status !== 'uploading' && (
            <button className="btn btn-secondary" disabled={busy} onClick={() => run(() => onOriginal(doc.id))}>
              {doc.ext === 'pdf' || doc.name.toLowerCase().endsWith('.pdf') ? 'Xem file gốc' : 'Tải file gốc'}
            </button>
          )}
          <button className="btn btn-secondary" onClick={() => setEditing(true)}>
            Sửa
          </button>
          <button className="btn btn-secondary" onClick={() => setConfirming(true)}>
            Xóa
          </button>
        </div>
      )}
    </article>
  )
}

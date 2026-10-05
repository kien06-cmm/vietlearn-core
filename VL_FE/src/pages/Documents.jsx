// Chức năng: trang Tài liệu - tải lên (có thanh tiến độ), thư viện (tìm, thư mục, tag, ghim), theo dõi xử lý, xem lại từng trang.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  completeDocument,
  createDocument,
  deleteDocument,
  getDocument,
  getDocumentFileUrl,
  getQuota,
  listDocuments,
  updateDocument,
  uploadToSignedUrl,
} from '../services/api.js'
import Icon from '../components/Icon.jsx'
import DocumentCard from '../components/DocumentCard.jsx'
import DocumentViewer from '../components/DocumentViewer.jsx'

const MIME_BY_EXT = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
}
const POLL_MS = 3000 // hỏi lại trạng thái tài liệu đang xử lý (chỉ hỏi đúng các tài liệu đó, tiết kiệm lượt đọc)

export default function Documents({ getToken }) {
  const [docs, setDocs] = useState(null)
  const [quota, setQuota] = useState(null)
  const [error, setError] = useState('')
  const [upload, setUpload] = useState(null) // { name, percent?, finishing?, error? }
  const [query, setQuery] = useState('')
  const [folder, setFolder] = useState('')
  const [tag, setTag] = useState('')
  const [onlyPinned, setOnlyPinned] = useState(false)
  const [viewing, setViewing] = useState(null)
  const fileRef = useRef(null)

  const reload = useCallback(async () => {
    try {
      const token = await getToken()
      const [list, q] = await Promise.all([listDocuments(token), getQuota(token)])
      setDocs(list.documents)
      setQuota(q.quota)
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [getToken])

  useEffect(() => {
    reload()
  }, [reload])

  // Theo dõi tiến độ các tài liệu đang chờ/đang xử lý
  const activeKey = (docs || [])
    .filter((d) => d.status === 'queued' || d.status === 'processing')
    .map((d) => d.id)
    .join(',')

  useEffect(() => {
    if (!activeKey) return
    const ids = activeKey.split(',')
    const timer = setInterval(async () => {
      if (document.hidden) return
      try {
        const token = await getToken()
        const fresh = await Promise.all(ids.map((id) => getDocument(token, id).then((r) => r.document).catch(() => null)))
        setDocs((cur) => cur && cur.map((d) => fresh.find((f) => f && f.id === d.id) || d))
      } catch {
        // thử lại ở lần hỏi sau
      }
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [activeKey, getToken])

  // Tải một file: tạo bản ghi -> PUT lên Storage -> báo xong. Trả về false nếu lỗi (thông báo nằm trong state upload).
  async function uploadOne(file) {
    const ext = file.name.split('.').pop().toLowerCase()
    const mimeType = MIME_BY_EXT[ext]
    if (!mimeType) {
      setUpload({ name: file.name, error: 'Chỉ hỗ trợ file PDF, DOCX hoặc TXT.' })
      return false
    }
    if (quota && file.size > quota.maxFileBytes) {
      setUpload({ name: file.name, error: `File quá lớn (tối đa ${quota.maxFileBytes / 1048576} MB).` })
      return false
    }

    let created = null
    let uploaded = false
    try {
      setUpload({ name: file.name, percent: 0 })
      const res = await createDocument(await getToken(), { name: file.name, mimeType, sizeBytes: file.size })
      created = res.document
      await uploadToSignedUrl(res.upload.url, file, mimeType, (percent) => setUpload({ name: file.name, percent }))
      uploaded = true
      setUpload({ name: file.name, percent: 100, finishing: true })
      await completeDocument(await getToken(), created.id)
      setUpload(null)
      return true
    } catch (err) {
      // Tải lên hỏng giữa chừng: xóa bản ghi để không chiếm hạn mức
      if (created && !uploaded) deleteDocument(await getToken(), created.id).catch(() => {})
      setUpload({ name: file.name, error: err.message })
      return false
    }
  }

  async function handleFiles(e) {
    const files = Array.from(e.target.files || [])
    e.target.value = ''
    for (const file of files) {
      if (!(await uploadOne(file))) break
      await reload() // hiện tài liệu vừa tải ngay, rồi mới tải file tiếp theo
    }
    await reload()
  }

  async function patchDoc(id, changes) {
    const res = await updateDocument(await getToken(), id, changes)
    setDocs((cur) => cur.map((d) => (d.id === id ? res.document : d)))
  }

  // Mở file gốc ở tab mới (PDF xem trực tiếp; DOCX/TXT thì trình duyệt tải về).
  // Mở tab TRƯỚC khi gọi API để điện thoại không chặn popup.
  async function openOriginal(id) {
    const tab = window.open('about:blank', '_blank')
    try {
      const res = await getDocumentFileUrl(await getToken(), id)
      if (tab) tab.location.href = res.url
      else window.location.href = res.url
    } catch (err) {
      if (tab) tab.close()
      throw err
    }
  }

  async function removeDoc(id) {
    await deleteDocument(await getToken(), id)
    setDocs((cur) => cur.filter((d) => d.id !== id))
    setQuota((q) => q && { ...q, usedDocuments: Math.max(0, q.usedDocuments - 1) })
  }

  const folders = useMemo(() => [...new Set((docs || []).map((d) => d.folder).filter(Boolean))].sort(), [docs])
  const tags = useMemo(() => [...new Set((docs || []).flatMap((d) => d.tags))].sort(), [docs])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return (docs || [])
      .filter((d) => (!needle || d.name.toLowerCase().includes(needle)) && (!folder || d.folder === folder))
      .filter((d) => (!tag || d.tags.includes(tag)) && (!onlyPinned || d.pinned))
      .sort((a, b) => Number(b.pinned) - Number(a.pinned)) // ghim lên đầu, giữ nguyên thứ tự mới nhất
  }, [docs, query, folder, tag, onlyPinned])

  if (viewing) return <DocumentViewer doc={viewing} getToken={getToken} onClose={() => setViewing(null)} />

  const uploading = upload && !upload.error

  return (
    <>
      <section>
        <h1>Tài liệu</h1>
        {quota && (
          <p className="hint">
            {quota.usedDocuments}/{quota.maxDocuments} tài liệu · tối đa {quota.maxFileBytes / 1048576} MB và {quota.maxPages} trang
            mỗi file · gói {quota.plan}
          </p>
        )}
      </section>

      <section className="card">
        <input ref={fileRef} type="file" accept=".pdf,.docx,.txt" multiple hidden onChange={handleFiles} />
        <button className="btn btn-primary btn-icon" disabled={uploading} onClick={() => fileRef.current?.click()}>
          <Icon name="upload" size={20} />
          {uploading ? 'Đang tải lên...' : 'Tải tài liệu lên'}
        </button>
        <p className="hint">Hỗ trợ PDF, DOCX, TXT.</p>

        {upload && (
          <div className="upload-state" role="status">
            <p className="hint">{upload.name}</p>
            {upload.error ? (
              <p className="msg msg-error" role="alert">
                {upload.error}
              </p>
            ) : (
              <>
                <div className="bar" aria-hidden="true">
                  <span style={{ width: `${upload.percent ?? 0}%` }} />
                </div>
                <p className="hint">{upload.finishing ? 'Đang kiểm tra file...' : `Đang tải lên ${upload.percent ?? 0}%`}</p>
              </>
            )}
          </div>
        )}
      </section>

      {error && (
        <p className="msg msg-error" role="alert">
          {error}
        </p>
      )}

      {docs === null && !error && <p className="hint">Đang tải thư viện...</p>}

      {docs && docs.length === 0 && (
        <section className="card empty">
          <span className="tile-icon">
            <Icon name="file" size={26} />
          </span>
          <h2>Chưa có tài liệu</h2>
          <p className="hint">Tải PDF, DOCX hoặc TXT lên để bắt đầu.</p>
        </section>
      )}

      {docs && docs.length > 0 && (
        <>
          <section className="card filters">
            <label className="span-2">
              Tìm theo tên
              <input type="search" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Nhập tên tài liệu..." />
            </label>
            <label>
              Thư mục
              <select value={folder} onChange={(e) => setFolder(e.target.value)}>
                <option value="">Tất cả</option>
                {folders.map((f) => (
                  <option key={f} value={f}>
                    {f}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Tag
              <select value={tag} onChange={(e) => setTag(e.target.value)}>
                <option value="">Tất cả</option>
                {tags.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="row span-2">
              Chỉ hiện tài liệu đã ghim
              <input type="checkbox" checked={onlyPinned} onChange={(e) => setOnlyPinned(e.target.checked)} />
            </label>
          </section>

          {shown.length === 0 && <p className="hint">Không có tài liệu nào khớp bộ lọc.</p>}
          {shown.map((d) => (
            <DocumentCard key={d.id} doc={d} onOpen={setViewing} onOriginal={openOriginal} onPatch={patchDoc} onDelete={removeDoc} />
          ))}
        </>
      )}
    </>
  )
}

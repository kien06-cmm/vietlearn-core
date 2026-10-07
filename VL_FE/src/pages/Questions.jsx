// Chức năng: trang Câu hỏi (Question Bank) - tạo câu hỏi bằng AI, duyệt từng câu hoặc hàng loạt, sửa, xóa,
// bấm "Xem nguồn" để mở đúng trang trong tài liệu. Lọc theo chủ đề, tài liệu, trạng thái duyệt.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { approveManyQuestions, deleteTopic, listDocuments, listQuestions, listTopics } from '../services/api.js'
import QuestionGenerator from '../components/QuestionGenerator.jsx'
import ImportQuestions from '../components/ImportQuestions.jsx'
import QuestionCard from '../components/QuestionCard.jsx'
import DocumentViewer from '../components/DocumentViewer.jsx'
import './Questions.css'

const BULK_LIMIT = 50 // backend duyệt tối đa 50 câu mỗi lần

export default function Questions({ getToken }) {
  const [docs, setDocs] = useState([])
  const [topics, setTopics] = useState([])
  const [questions, setQuestions] = useState(null)
  const [filters, setFilters] = useState({ topicId: '', documentId: '', reviewStatus: '', jobId: '' })
  const [error, setError] = useState('')
  const [bulkBusy, setBulkBusy] = useState(false)
  const [bulkMsg, setBulkMsg] = useState('')
  const [viewing, setViewing] = useState(null) // { doc, page }
  const [showImport, setShowImport] = useState(false)
  const [refresh, setRefresh] = useState(0)
  const [confirmTopic, setConfirmTopic] = useState(false)
  const [topicBusy, setTopicBusy] = useState(false)

  // Tải tài liệu + chủ đề một lần
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const token = await getToken()
        const [d, t] = await Promise.all([listDocuments(token), listTopics(token)])
        if (cancelled) return
        setDocs(d.documents)
        setTopics(t.topics)
      } catch (err) {
        if (!cancelled) setError(err.message)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [getToken])

  const { topicId, documentId, reviewStatus, jobId } = filters

  const loadQuestions = useCallback(async () => {
    try {
      const token = await getToken()
      const res = await listQuestions(token, { topicId, documentId, reviewStatus, jobId })
      setQuestions(res.questions)
      setError('')
    } catch (err) {
      setError(err.message)
    }
  }, [getToken, topicId, documentId, reviewStatus, jobId])

  useEffect(() => {
    loadQuestions()
  }, [loadQuestions, refresh])

  const topicLabels = useMemo(
    () => Object.fromEntries(topics.map((t) => [t.id, `${t.subject} › ${t.chapter} › ${t.name}`])),
    [topics]
  )

  const handleTopicCreated = useCallback((topic) => {
    setTopics((cur) => (cur.some((t) => t.id === topic.id) ? cur : [...cur, topic]))
  }, [])

  // Job xong: chỉ hiện câu của job đó (để duyệt ngay), bấm "Xem tất cả" để bỏ lọc
  const handleJobDone = useCallback((id) => {
    setFilters({ topicId: '', documentId: '', reviewStatus: '', jobId: id })
  }, [])

  // Nhập đề xong: hiện các câu nháp của chủ đề vừa nhập
  const handleImported = useCallback((importedTopicId) => {
    setFilters({ topicId: importedTopicId, documentId: '', reviewStatus: 'draft', jobId: '' })
    setRefresh((n) => n + 1)
  }, [])

  function setFilter(key, value) {
    setFilters((cur) => ({ ...cur, [key]: value, ...(key === 'jobId' ? {} : { jobId: '' }) }))
    setConfirmTopic(false)
  }

  async function removeTopic() {
    setTopicBusy(true)
    try {
      await deleteTopic(await getToken(), topicId)
      setTopics((cur) => cur.filter((t) => t.id !== topicId))
      setFilters((cur) => ({ ...cur, topicId: '' }))
      setError('')
    } catch (err) {
      setError(err.message)
    } finally {
      setTopicBusy(false)
      setConfirmTopic(false)
    }
  }

  const drafts = (questions || []).filter((q) => q.reviewStatus !== 'approved')

  async function approveAllShown() {
    setBulkBusy(true)
    setBulkMsg('')
    try {
      const token = await getToken()
      let approved = 0
      let skipped = 0
      for (let i = 0; i < drafts.length; i += BULK_LIMIT) {
        const ids = drafts.slice(i, i + BULK_LIMIT).map((q) => q.id)
        const res = await approveManyQuestions(token, ids)
        approved += res.approved
        skipped += res.skipped
      }
      setBulkMsg(`Đã duyệt ${approved} câu${skipped ? `, bỏ qua ${skipped} câu chưa hợp lệ (hãy sửa rồi duyệt lại)` : ''}.`)
      await loadQuestions()
    } catch (err) {
      setBulkMsg(err.message)
    } finally {
      setBulkBusy(false)
    }
  }

  // Mở trang nguồn: lấy tài liệu từ danh sách đã tải, nếu chưa có thì tải lại danh sách
  async function openPage({ documentId: id, pageNumber }) {
    let doc = docs.find((d) => d.id === id)
    if (!doc) {
      try {
        const list = (await listDocuments(await getToken())).documents
        setDocs(list)
        doc = list.find((d) => d.id === id)
      } catch (err) {
        setError(err.message)
        return
      }
    }
    if (!doc) return setError('Không tìm thấy tài liệu nguồn (có thể đã bị xóa).')
    setViewing({ doc, page: pageNumber })
    window.scrollTo(0, 0)
  }

  if (viewing) {
    return <DocumentViewer doc={viewing.doc} initialPage={viewing.page} getToken={getToken} onClose={() => setViewing(null)} />
  }

  return (
    <>
      <section>
        <h1>Câu hỏi</h1>
        <p className="hint">Tạo câu hỏi từ tài liệu hoặc nhập đề có sẵn, duyệt rồi lưu vào ngân hàng câu hỏi.</p>
        <button className="btn btn-secondary" aria-expanded={showImport} onClick={() => setShowImport((v) => !v)}>
          {showImport ? 'Đóng nhập đề' : 'Nhập đề có sẵn'}
        </button>
      </section>

      {showImport && (
        <ImportQuestions getToken={getToken} topics={topics} onTopicCreated={handleTopicCreated} onImported={handleImported} />
      )}

      <QuestionGenerator getToken={getToken} docs={docs} topics={topics} onTopicCreated={handleTopicCreated} onDone={handleJobDone} />

      <section className="card filters">
        <h2 className="span-2">Ngân hàng câu hỏi</h2>
        <label>
          Chủ đề
          <select value={topicId} onChange={(e) => setFilter('topicId', e.target.value)}>
            <option value="">Tất cả</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {topicLabels[t.id]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tài liệu
          <select value={documentId} onChange={(e) => setFilter('documentId', e.target.value)}>
            <option value="">Tất cả</option>
            {docs.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label className="span-2">
          Trạng thái
          <select value={reviewStatus} onChange={(e) => setFilter('reviewStatus', e.target.value)}>
            <option value="">Tất cả</option>
            <option value="draft">Nháp (chưa duyệt)</option>
            <option value="approved">Đã duyệt</option>
          </select>
        </label>

        {topicId && (
          <div className="span-2 doc-actions">
            {confirmTopic ? (
              <>
                <button className="btn btn-danger" disabled={topicBusy} onClick={removeTopic}>
                  {topicBusy ? 'Đang xóa...' : 'Xác nhận xóa chủ đề'}
                </button>
                <button className="btn btn-secondary" disabled={topicBusy} onClick={() => setConfirmTopic(false)}>
                  Hủy
                </button>
              </>
            ) : (
              <button className="btn btn-secondary" onClick={() => setConfirmTopic(true)}>
                Xóa chủ đề này
              </button>
            )}
          </div>
        )}

        {jobId && (
          <div className="span-2 doc-actions">
            <p className="hint">Đang hiện các câu vừa tạo.</p>
            <button className="btn btn-secondary" onClick={() => setFilter('jobId', '')}>
              Xem tất cả
            </button>
          </div>
        )}
      </section>

      {error && (
        <p className="msg msg-error" role="alert">
          {error}
        </p>
      )}

      {questions === null && !error && <p className="hint">Đang tải câu hỏi...</p>}

      {questions && questions.length === 0 && (
        <section className="card empty">
          <h2>Chưa có câu hỏi nào</h2>
          <p className="hint">Chọn một tài liệu ở trên rồi bấm "Tạo câu hỏi", hoặc bấm "Nhập đề có sẵn".</p>
        </section>
      )}

      {questions && questions.length > 0 && (
        <>
          <section className="card">
            <p className="hint">
              {questions.length} câu · {drafts.length} câu chưa duyệt
            </p>
            {drafts.length > 0 && (
              <button className="btn btn-primary" disabled={bulkBusy} onClick={approveAllShown}>
                {bulkBusy ? 'Đang duyệt...' : `Duyệt tất cả ${drafts.length} câu nháp đang hiện`}
              </button>
            )}
            <p className="hint">Nên đọc lướt từng câu và bấm "Xem nguồn" trước khi duyệt hàng loạt.</p>
            {bulkMsg && <p className="msg-ok">{bulkMsg}</p>}
          </section>

          {questions.map((q) => (
            <QuestionCard
              key={q.id}
              q={q}
              topicLabel={topicLabels[q.topicId]}
              getToken={getToken}
              onChanged={(next) => setQuestions((cur) => cur.map((x) => (x.id === next.id ? { ...x, ...next } : x)))}
              onRemoved={(id) => setQuestions((cur) => cur.filter((x) => x.id !== id))}
              onOpenPage={openPage}
            />
          ))}
        </>
      )}
    </>
  )
}

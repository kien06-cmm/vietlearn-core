// Chức năng: thẻ một câu hỏi trong màn duyệt - hiện đề + đáp án đúng, nút Xem nguồn (đoạn tài liệu gốc), Sửa, Duyệt, Xóa.
import { useState } from 'react'
import { approveQuestion, deleteQuestion, getQuestionSource, updateQuestion } from '../services/api.js'
import MathText from './MathText.jsx'
import '../pages/Questions.css'

export const TYPE_LABELS = {
  single: '4 lựa chọn',
  multi: 'Nhiều đáp án',
  truefalse: 'Đúng/Sai',
  fill: 'Điền khuyết',
  short: 'Trả lời ngắn',
}

// Lý do backend từ chối câu hỏi đã sửa (mã trả về trong err.code)
const REASON_TEXT = {
  'missing-answer': 'Câu hỏi chưa có đáp án đúng.',
  'duplicate-options': 'Có hai lựa chọn giống nhau.',
  'invalid-answer': 'Đáp án đúng không hợp lệ (nhiều đáp án: chọn ít nhất 2 và không chọn tất cả).',
  'bad-blank': 'Câu điền khuyết phải có đúng một chỗ trống viết là ____ .',
  'invalid-schema': 'Nội dung chưa hợp lệ (đề tối thiểu 10 ký tự, các lựa chọn không được để trống).',
}

function errorText(err) {
  return REASON_TEXT[err.code] ? `${err.message}. ${REASON_TEXT[err.code]}` : err.message
}

// Chỉ số các lựa chọn đúng (đúng/sai: "Đúng" là lựa chọn 0, "Sai" là lựa chọn 1)
function correctIndexes(q) {
  const c = q.answer?.correct
  if (q.type === 'single') return [c]
  if (q.type === 'multi') return Array.isArray(c) ? c : []
  if (q.type === 'truefalse') return [c === true ? 0 : 1]
  return []
}

function EditForm({ q, onSave, onCancel, busy }) {
  const hasOptions = q.type === 'single' || q.type === 'multi'
  const [stem, setStem] = useState(q.stem)
  const [options, setOptions] = useState(q.options)
  const [correct, setCorrect] = useState(q.answer?.correct ?? '')
  const [alternatives, setAlternatives] = useState((q.answer?.alternatives || []).join(', '))
  const [explanation, setExplanation] = useState(q.explanation)

  function toggleMulti(i) {
    const cur = Array.isArray(correct) ? correct : []
    setCorrect(cur.includes(i) ? cur.filter((x) => x !== i) : [...cur, i].sort((a, b) => a - b))
  }

  function submit(e) {
    e.preventDefault()
    const changes = { stem: stem.trim(), explanation: explanation.trim() }
    if (hasOptions) changes.options = options.map((o) => o.trim())
    if (q.type !== 'truefalse' || typeof correct === 'boolean') changes.correct = correct
    if (q.type === 'fill') {
      changes.alternatives = alternatives
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    }
    onSave(changes)
  }

  return (
    <form className="card" onSubmit={submit}>
      <label>
        Đề bài (công thức viết trong $...$)
        <textarea value={stem} onChange={(e) => setStem(e.target.value)} maxLength={500} required />
      </label>

      {hasOptions && (
        <fieldset className="check-list" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="hint">{q.type === 'single' ? 'Các lựa chọn (chọn 1 đáp án đúng)' : 'Các lựa chọn (tick các đáp án đúng)'}</legend>
          {options.map((opt, i) => (
            <div key={i} className="check-row">
              <input
                type={q.type === 'single' ? 'radio' : 'checkbox'}
                name={`correct-${q.id}`}
                checked={q.type === 'single' ? correct === i : Array.isArray(correct) && correct.includes(i)}
                onChange={() => (q.type === 'single' ? setCorrect(i) : toggleMulti(i))}
                aria-label={`Lựa chọn ${i + 1} là đáp án đúng`}
              />
              <input
                style={{ flex: 1 }}
                value={opt}
                onChange={(e) => setOptions(options.map((o, j) => (j === i ? e.target.value : o)))}
                maxLength={200}
                required
                aria-label={`Nội dung lựa chọn ${i + 1}`}
              />
            </div>
          ))}
        </fieldset>
      )}

      {q.type === 'truefalse' && (
        <label>
          Đáp án đúng
          <select value={String(correct)} onChange={(e) => setCorrect(e.target.value === 'true')}>
            <option value="true">Đúng</option>
            <option value="false">Sai</option>
          </select>
        </label>
      )}

      {q.type === 'fill' && (
        <>
          <label>
            Từ/cụm cần điền
            <input value={correct} onChange={(e) => setCorrect(e.target.value)} maxLength={100} required />
          </label>
          <label>
            Cách viết khác cũng đúng (cách nhau bằng dấu phẩy)
            <input value={alternatives} onChange={(e) => setAlternatives(e.target.value)} />
          </label>
        </>
      )}

      {q.type === 'short' && (
        <label>
          Đáp án mẫu
          <textarea value={correct} onChange={(e) => setCorrect(e.target.value)} maxLength={300} required />
        </label>
      )}

      <label>
        Giải thích
        <textarea value={explanation} onChange={(e) => setExplanation(e.target.value)} maxLength={600} />
      </label>

      <p className="hint">Sửa xong, câu hỏi quay về trạng thái nháp để bạn duyệt lại.</p>
      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? 'Đang lưu...' : 'Lưu'}
      </button>
      <button type="button" className="btn btn-secondary" disabled={busy} onClick={onCancel}>
        Hủy
      </button>
    </form>
  )
}

// onChanged(câu mới) | onRemoved(id) | onOpenPage({ documentId, pageNumber }) mở trang gốc trong trình xem tài liệu
export default function QuestionCard({ q, topicLabel, getToken, onChanged, onRemoved, onOpenPage }) {
  const [mode, setMode] = useState('view') // view | edit | confirm-delete
  const [source, setSource] = useState(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const marks = correctIndexes(q)
  const approved = q.reviewStatus === 'approved'

  async function run(action) {
    setBusy(true)
    setMsg('')
    try {
      return await action()
    } catch (err) {
      setMsg(errorText(err))
      return undefined
    } finally {
      setBusy(false)
    }
  }

  async function toggleSource() {
    if (source) return setSource(null)
    const res = await run(async () => getQuestionSource(await getToken(), q.id))
    if (res) setSource(res.source)
  }

  async function handleApprove() {
    const res = await run(async () => approveQuestion(await getToken(), q.id))
    if (res) onChanged({ ...q, reviewStatus: 'approved' })
  }

  async function handleSave(changes) {
    const res = await run(async () => updateQuestion(await getToken(), q.id, changes))
    if (res) {
      onChanged(res.question)
      setSource(null)
      setMode('view')
    }
  }

  async function handleDelete() {
    const res = await run(async () => deleteQuestion(await getToken(), q.id))
    if (res) onRemoved(q.id)
  }

  return (
    <article className="card">
      <div className="q-top">
        <span className="badge">{TYPE_LABELS[q.type] || q.type}</span>
        <span className={`badge ${approved ? 'badge-ok' : 'badge-draft'}`}>{approved ? 'Đã duyệt' : 'Nháp'}</span>
        {topicLabel && <span className="chip">{topicLabel}</span>}
        {q.source?.pageNumber && <span className="chip">Trang {q.source.pageNumber}</span>}
        {q.origin === 'import' && <span className="chip">Nhập từ file</span>}
      </div>

      {mode === 'edit' ? (
        <EditForm q={q} busy={busy} onSave={handleSave} onCancel={() => setMode('view')} />
      ) : (
        <>
          <p className="q-stem">
            <MathText text={q.stem} />
          </p>

          {q.options.length > 0 && (
            <ul className="q-options">
              {q.options.map((opt, i) => (
                <li key={i} className={`q-option ${marks.includes(i) ? 'q-option-correct' : ''}`}>
                  <span className="q-option-mark" aria-label={marks.includes(i) ? 'Đáp án đúng' : undefined}>
                    {marks.includes(i) ? '✓' : ''}
                  </span>
                  <MathText text={opt} />
                </li>
              ))}
            </ul>
          )}

          {q.type === 'fill' && (
            <p className="q-answer">
              Đáp án: <strong><MathText text={q.answer?.correct} /></strong>
              {q.answer?.alternatives?.length > 0 && <span className="hint"> · chấp nhận: {q.answer.alternatives.join(', ')}</span>}
            </p>
          )}
          {q.type === 'short' && (
            <p className="q-answer">
              Đáp án mẫu: <MathText text={q.answer?.correct} />
            </p>
          )}

          {q.explanation && (
            <p className="q-explain">
              Giải thích: <MathText text={q.explanation} />
            </p>
          )}
        </>
      )}

      {source && (
        <div className="q-source">
          <p className="hint">Đoạn tài liệu gốc · trang {source.pageNumber}</p>
          <div className="q-source-text">
            <MathText text={source.text} />
          </div>
          <button className="btn btn-secondary" onClick={() => onOpenPage({ documentId: source.documentId, pageNumber: source.pageNumber })}>
            Mở trang {source.pageNumber} trong tài liệu
          </button>
        </div>
      )}

      {msg && (
        <p className="msg msg-error" role="alert">
          {msg}
        </p>
      )}

      {mode === 'confirm-delete' && (
        <div className="doc-actions">
          <button className="btn btn-danger" disabled={busy} onClick={handleDelete}>
            {busy ? 'Đang xóa...' : 'Xác nhận xóa'}
          </button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => setMode('view')}>
            Hủy
          </button>
        </div>
      )}

      {mode === 'view' && (
        <div className="doc-actions">
          {!approved && (
            <button className="btn btn-primary" disabled={busy} onClick={handleApprove}>
              Duyệt
            </button>
          )}
          {q.source && (
            <button className="btn btn-secondary" disabled={busy} onClick={toggleSource}>
              {source ? 'Ẩn nguồn' : 'Xem nguồn'}
            </button>
          )}
          <button className="btn btn-secondary" disabled={busy} onClick={() => setMode('edit')}>
            Sửa
          </button>
          <button className="btn btn-secondary" disabled={busy} onClick={() => setMode('confirm-delete')}>
            Xóa
          </button>
        </div>
      )}
    </article>
  )
}

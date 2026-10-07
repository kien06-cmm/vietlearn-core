// Chức năng: nhập đề trắc nghiệm có sẵn (.xlsx/.docx/.txt) - chọn chủ đề, chọn file, xem trước, xác nhận. Có file mẫu và lệnh cho AI khác.
import { useState } from 'react'
import { createTopic, downloadImportSample, importQuestions } from '../services/api.js'
import MathText from './MathText.jsx'
import '../pages/Questions.css'

const MAX_BYTES = 2 * 1024 * 1024
const NEW_TOPIC = '__new__'
const LETTERS = ['A', 'B', 'C', 'D']
const EXTS = ['xlsx', 'docx', 'txt']

const AI_PROMPT = `Bạn là trợ lý chuyển đề trắc nghiệm sang định dạng nhập của VietLearn. Hãy chuyển TOÀN BỘ đề tôi gửi ở cuối tin nhắn này sang đúng định dạng sau (mỗi câu như ví dụ):

Câu 1. Nội dung câu hỏi
A. Lựa chọn A
B. Lựa chọn B
C. Lựa chọn C
D. Lựa chọn D
Đáp án: B
Giải thích: Giải thích ngắn (bỏ dòng này nếu không có)

Quy tắc bắt buộc:
- Mỗi câu có đúng 4 lựa chọn A, B, C, D (mỗi lựa chọn một dòng) và đúng 1 đáp án. Dòng "Đáp án:" chỉ ghi một chữ cái A, B, C hoặc D.
- Đánh số liên tục "Câu 1.", "Câu 2.", ... và để một dòng trống giữa các câu.
- Công thức toán, lý, hóa viết bằng LaTeX và đặt trong một cặp dấu đô la, ví dụ $x^2 + 2x + 1 = 0$. Không dùng cách bao công thức nào khác.
- Chỉ xuất văn bản thuần: không in đậm, không in nghiêng, không bảng, không gạch đầu dòng, không markdown, không lời dẫn hay lời kết.
- Giữ nguyên nội dung gốc. Không tự bịa câu hỏi, không tự đổi đáp án. Nếu một câu không có đáp án, đừng đoán: bỏ câu đó và ghi chú số câu bị bỏ ở NGOÀI khối mã.
- Tối đa 200 câu mỗi lần. Nếu đề dài hơn, dừng ở câu thứ 200 và nhắc tôi gõ "tiếp".
- Đặt toàn bộ kết quả trong MỘT khối mã (code block) để tôi sao chép.

Đề của tôi:
(dán đề vào đây)`

function checkFile(file) {
  const ext = file.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  if (ext === 'doc' || ext === 'xls') return 'File .doc/.xls (bản cũ) chưa hỗ trợ. Hãy mở bằng Word/Excel rồi Lưu thành .docx/.xlsx.'
  if (!EXTS.includes(ext)) return 'Chỉ hỗ trợ file .xlsx, .docx hoặc .txt.'
  if (file.size === 0) return 'File rỗng.'
  if (file.size > MAX_BYTES) return 'File quá lớn (tối đa 2 MB).'
  return ''
}

function readBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = () => reject(new Error('Không đọc được file. Hãy thử chọn lại.'))
    reader.readAsDataURL(file)
  })
}

export default function ImportQuestions({ getToken, topics, onTopicCreated, onImported }) {
  const [topicId, setTopicId] = useState('')
  const [newTopic, setNewTopic] = useState({ subject: '', chapter: '', name: '' })
  const [file, setFile] = useState(null)
  const [fileKey, setFileKey] = useState(0)
  const [preview, setPreview] = useState(null) // { payload, data }
  const [busy, setBusy] = useState('') // '' | 'preview' | 'import'
  const [error, setError] = useState('')
  const [result, setResult] = useState(null)
  const [sampleBusy, setSampleBusy] = useState('')
  const [copyState, setCopyState] = useState('') // '' | 'ok' | 'manual'

  const topicOk = topicId && (topicId !== NEW_TOPIC || (newTopic.subject.trim() && newTopic.chapter.trim() && newTopic.name.trim()))

  function clearPreview() {
    setPreview(null)
    setResult(null)
    setError('')
  }

  function resetFile() {
    setFile(null)
    setFileKey((k) => k + 1)
  }

  async function handleSample(format) {
    setError('')
    setSampleBusy(format)
    try {
      const blob = await downloadImportSample(await getToken(), format)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `mau-nhap-de.${format}`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (err) {
      setError(err.message)
    } finally {
      setSampleBusy('')
    }
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(AI_PROMPT)
      setCopyState('ok')
      setTimeout(() => setCopyState(''), 3000)
    } catch {
      setCopyState('manual')
    }
  }

  async function handlePreview(e) {
    e.preventDefault()
    clearPreview()
    const problem = checkFile(file)
    if (problem) return setError(problem)

    setBusy('preview')
    try {
      const token = await getToken()
      let tid = topicId
      if (tid === NEW_TOPIC) {
        const res = await createTopic(token, newTopic)
        tid = res.topic.id
        onTopicCreated(res.topic)
        setTopicId(tid)
      }
      const payload = { fileName: file.name, fileBase64: await readBase64(file), topicId: tid }
      const data = await importQuestions(token, payload)
      setPreview({ payload, data })
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  async function handleConfirm() {
    setError('')
    setBusy('import')
    try {
      const res = await importQuestions(await getToken(), { ...preview.payload, confirm: true })
      setResult({ imported: res.imported, skipped: res.skipped })
      onImported(preview.payload.topicId)
      setPreview(null)
      resetFile()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy('')
    }
  }

  const d = preview?.data

  return (
    <section className="card">
      <h2>Nhập đề có sẵn</h2>
      <p className="hint">
        Nhập đề trắc nghiệm 4 lựa chọn từ file Excel, Word hoặc TXT. Không tốn AI credits. Các câu nhập vào ở trạng thái nháp để bạn duyệt.
      </p>

      <div className="doc-actions">
        <button className="btn btn-secondary" disabled={!!sampleBusy} onClick={() => handleSample('xlsx')}>
          {sampleBusy === 'xlsx' ? 'Đang tải...' : 'Tải file mẫu Excel'}
        </button>
        <button className="btn btn-secondary" disabled={!!sampleBusy} onClick={() => handleSample('docx')}>
          {sampleBusy === 'docx' ? 'Đang tải...' : 'Tải file mẫu Word'}
        </button>
        <button className="btn btn-secondary" onClick={handleCopy}>
          {copyState === 'ok' ? 'Đã sao chép' : 'Sao chép lệnh cho AI khác'}
        </button>
      </div>
      <p className="hint">
        Đề đang ở dạng ảnh hoặc PDF? Sao chép lệnh, dán vào AI khác (ChatGPT, Gemini...) cùng đề của bạn để chuyển sang đúng định dạng, rồi lưu kết quả
        thành file .txt hoặc .docx.
      </p>
      {copyState === 'manual' && (
        <label>
          Không tự sao chép được. Hãy bôi đen toàn bộ và sao chép thủ công:
          <textarea className="prompt-box" readOnly value={AI_PROMPT} onFocus={(e) => e.target.select()} />
        </label>
      )}

      <form className="card" onSubmit={handlePreview}>
        <label>
          Chủ đề (Môn › Chương › Chủ đề)
          <select
            value={topicId}
            onChange={(e) => {
              setTopicId(e.target.value)
              clearPreview()
            }}
            required
          >
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
          File đề (.xlsx, .docx, .txt - tối đa 2 MB, 200 câu)
          <input
            key={fileKey}
            type="file"
            accept=".xlsx,.docx,.txt"
            onChange={(e) => {
              setFile(e.target.files?.[0] || null)
              clearPreview()
            }}
            required
          />
        </label>

        <button className="btn btn-primary" type="submit" disabled={!!busy || !file || !topicOk}>
          {busy === 'preview' ? 'Đang đọc file...' : 'Xem trước'}
        </button>
      </form>

      {error && (
        <p className="msg msg-error" role="alert">
          {error}
        </p>
      )}

      {result && (
        <p className="msg-ok" role="status">
          Đã nhập {result.imported} câu (trạng thái nháp, hãy duyệt bên dưới).
          {result.skipped > 0 && ` Bỏ qua ${result.skipped} câu lỗi hoặc trùng.`}
        </p>
      )}

      {d && (
        <div className="upload-state">
          <p className="hint">
            Đọc được {d.found} câu · hợp lệ {d.valid} · bỏ qua {d.skipped}
          </p>

          {d.preview.length > 0 && (
            <div className="table-wrap">
              <table className="import-table">
                <thead>
                  <tr>
                    <th>Câu</th>
                    <th>Đề bài</th>
                    {LETTERS.map((l) => (
                      <th key={l}>{l}</th>
                    ))}
                    <th>Đáp án</th>
                  </tr>
                </thead>
                <tbody>
                  {d.preview.map((p, i) => (
                    <tr key={i}>
                      <td>{p.label}</td>
                      <td>
                        <MathText text={p.stem} />
                      </td>
                      {p.options.map((opt, j) => (
                        <td key={j} className={j === p.correct ? 'cell-correct' : undefined}>
                          <MathText text={opt} />
                        </td>
                      ))}
                      <td>{LETTERS[p.correct]}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {d.valid > d.preview.length && <p className="hint">Chỉ hiện {d.preview.length} câu đầu. Cả {d.valid} câu hợp lệ sẽ được nhập.</p>}

          {d.errors.length > 0 && (
            <details className="import-errors" open={d.valid === 0}>
              <summary>{d.skipped} câu bị bỏ qua</summary>
              <ul>
                {d.errors.map((er, i) => (
                  <li key={i}>
                    <strong>{er.where}:</strong> {er.message}
                  </li>
                ))}
              </ul>
              {d.skipped > d.errors.length && <p className="hint">Và {d.skipped - d.errors.length} lỗi khác.</p>}
            </details>
          )}

          {d.valid === 0 ? (
            <p className="hint">Không có câu hợp lệ nào. Hãy sửa file theo các lỗi trên rồi chọn lại file.</p>
          ) : (
            <div className="doc-actions">
              <button className="btn btn-primary" disabled={!!busy} onClick={handleConfirm}>
                {busy === 'import' ? 'Đang nhập...' : `Nhập ${d.valid} câu hợp lệ`}
              </button>
              <button
                className="btn btn-secondary"
                disabled={!!busy}
                onClick={() => {
                  clearPreview()
                  resetFile()
                }}
              >
                Hủy
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  )
}

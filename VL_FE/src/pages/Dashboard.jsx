// Chức năng: trang Trang chủ - lời chào theo giờ, nhắc xác minh email, khối "Tiếp tục học" (tài liệu gần nhất), lối tắt, trạng thái hệ thống.
import { useEffect, useState } from 'react'
import { getHealth, listDocuments } from '../services/api.js'
import Icon from '../components/Icon.jsx'

const LINKS = [
  { href: '#/documents', title: 'Tài liệu', text: 'Tải tài liệu lên để tạo câu hỏi.' },
  { href: '#/questions', title: 'Câu hỏi', text: 'Tạo và duyệt câu hỏi từ tài liệu.' },
  { href: '#/quiz', title: 'Quiz & phòng', text: 'Tạo bài, mở phòng cho cả lớp.' },
  { href: '#/settings', title: 'Cài đặt', text: 'Giao diện, hồ sơ, tài khoản.' },
]

function greetingText() {
  const hour = new Date().getHours()
  if (hour < 11) return 'Chào buổi sáng'
  if (hour < 13) return 'Chào buổi trưa'
  if (hour < 18) return 'Chào buổi chiều'
  return 'Chào buổi tối'
}

export default function Dashboard({ user, profile, profileError, emailVerified, onResend, onCheckVerified, verifyMsg, getToken }) {
  const [backendStatus, setBackendStatus] = useState('Đang kết nối hệ thống...')
  const [docs, setDocs] = useState(null) // null: đang tải

  useEffect(() => {
    getHealth()
      .then((data) => setBackendStatus(data.message))
      .catch((err) => setBackendStatus('Lỗi kết nối: ' + err.message))
  }, [])

  // Lấy danh sách tài liệu để chọn tài liệu gần nhất; lỗi thì coi như chưa có tài liệu
  useEffect(() => {
    let cancelled = false
    getToken()
      .then((token) => listDocuments(token))
      .then((res) => !cancelled && setDocs(res.documents))
      .catch(() => !cancelled && setDocs([]))
    return () => {
      cancelled = true
    }
  }, [getToken])

  const statusError = backendStatus.startsWith('Lỗi')
  const ready = (docs || []).filter((d) => d.status === 'ready')
  const recent = ready.find((d) => d.pinned) || ready[0]

  return (
    <>
      <section className="greeting">
        <h1>
          {greetingText()}, {profile?.displayName || user.email}.
        </h1>
        <p className="hint">Hôm nay bạn muốn học gì?</p>
      </section>

      {profileError && (
        <p className="msg msg-error" role="alert">
          {profileError}
        </p>
      )}

      {!emailVerified && (
        <section className="card card-warn">
          <div className="notice-head">
            <Icon name="mail" size={20} />
            <strong>Xác minh email</strong>
          </div>
          <p className="hint">Email chưa được xác minh. Hãy mở email và bấm vào link xác minh.</p>
          <button className="btn btn-secondary" onClick={onResend}>
            Gửi lại email xác minh
          </button>
          <button className="btn btn-secondary" onClick={onCheckVerified}>
            Tôi đã xác minh
          </button>
          {verifyMsg && (
            <p className="hint" role="status">
              {verifyMsg}
            </p>
          )}
        </section>
      )}

      {docs !== null && (
        <section className="hero" aria-label="Tiếp tục học">
          {recent ? (
            <>
              <p className="hero-label">Tiếp tục học</p>
              <h2>{recent.name}</h2>
              <p className="hint">
                {recent.pageCount ? `${recent.pageCount} trang` : 'Tài liệu'}
                {recent.folder && ` · ${recent.folder}`}
              </p>
              <a className="btn btn-primary" href="#/documents">
                Mở tài liệu
              </a>
            </>
          ) : (
            <>
              <p className="hero-label">Bắt đầu</p>
              <h2>Tải tài liệu đầu tiên của bạn</h2>
              <p className="hint">Hỗ trợ PDF, DOCX, TXT. Sau đó bạn có thể tóm tắt, hỏi đáp và tạo câu hỏi ôn tập từ chính tài liệu đó.</p>
              <a className="btn btn-primary" href="#/documents">
                Tải tài liệu lên
              </a>
            </>
          )}
        </section>
      )}

      <ul className="rows" aria-label="Chức năng">
        {LINKS.map((link) => (
          <li key={link.href}>
            <a className="row-link" href={link.href}>
              <div>
                <h3>{link.title}</h3>
                <p>{link.text}</p>
              </div>
              <span className="tile-arrow">
                <Icon name="chevron" size={18} />
              </span>
            </a>
          </li>
        ))}
      </ul>

      <p className={`status${statusError ? ' status-error' : ''}`}>
        <span className="status-dot" aria-hidden="true" />
        Hệ thống: {backendStatus}
      </p>
    </>
  )
}

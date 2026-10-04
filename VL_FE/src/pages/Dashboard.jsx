// Chức năng: trang Dashboard - lời chào, nhắc xác minh email, lối vào các chức năng chính, trạng thái hệ thống.
import { useEffect, useState } from 'react'
import { getHealth } from '../services/api.js'

const TILES = [
  { href: '#/documents', icon: '📄', title: 'Tài liệu', text: 'Tải tài liệu lên để tạo câu hỏi.' },
  { href: '#/quiz', icon: '🎯', title: 'Quiz & phòng', text: 'Tạo bài, mở phòng cho cả lớp.' },
  { href: '#/settings', icon: '⚙️', title: 'Cài đặt', text: 'Giao diện, hồ sơ, tài khoản.' },
]

export default function Dashboard({ user, profile, profileError, emailVerified, onResend, onCheckVerified, verifyMsg }) {
  const [backendStatus, setBackendStatus] = useState('Đang kết nối hệ thống...')

  useEffect(() => {
    getHealth()
      .then((data) => setBackendStatus(data.message))
      .catch((err) => setBackendStatus('Lỗi kết nối: ' + err.message))
  }, [])

  return (
    <>
      <section>
        <h1>Xin chào, {profile?.displayName || user.email}!</h1>
        <p className="hint">{user.email}</p>
      </section>

      {profileError && (
        <p className="msg msg-error" role="alert">
          {profileError}
        </p>
      )}

      {!emailVerified && (
        <section className="card">
          <p className="msg msg-error">Email chưa được xác minh. Hãy mở email và bấm vào link xác minh.</p>
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

      <section className="tiles" aria-label="Chức năng">
        {TILES.map((tile) => (
          <a key={tile.href} className="tile" href={tile.href}>
            <span aria-hidden="true">{tile.icon}</span>
            <h3>{tile.title}</h3>
            <p>{tile.text}</p>
          </a>
        ))}
      </section>

      <p className="status">Hệ thống: {backendStatus}</p>
    </>
  )
}

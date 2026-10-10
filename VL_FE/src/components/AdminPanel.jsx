// Chức năng: bảng Admin tối thiểu (Phase 6) - tìm người dùng theo email và đổi gói free/pro. Chỉ hiện trong Cài đặt khi tài khoản có isAdmin. Backend kiểm tra lại quyền ở mỗi lần gọi.
import { useState } from 'react'
import { adminFindUsers, adminSetPlan } from '../services/api.js'

const PLANS = ['free', 'pro']

function UserCard({ user, busy, onSetPlan }) {
  return (
    <article className="card">
      <div className="q-top">
        <span className="badge">{user.plan}</span>
        {user.isAdmin && <span className="badge">Admin</span>}
        {user.deleted && <span className="badge">Đã xóa</span>}
      </div>
      <h3>{user.displayName || 'Chưa đặt tên'}</h3>
      <p className="hint">{user.email}</p>
      <p className="hint">Tạo lúc: {user.createdAt ? new Date(user.createdAt).toLocaleString('vi-VN') : 'không rõ'}</p>
      <div className="seg" role="group" aria-label="Đổi gói">
        {PLANS.map((plan) => (
          <button
            key={plan}
            type="button"
            className={`btn ${user.plan === plan ? 'btn-primary' : 'btn-secondary'}`}
            aria-pressed={user.plan === plan}
            disabled={busy || user.plan === plan}
            onClick={() => onSetPlan(user, plan)}
          >
            {plan}
          </button>
        ))}
      </div>
    </article>
  )
}

export default function AdminPanel({ getToken }) {
  const [email, setEmail] = useState('')
  const [users, setUsers] = useState(null) // null: chưa tìm
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [error, setError] = useState('')

  async function search(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    setMsg('')
    try {
      const res = await adminFindUsers(await getToken(), email.trim())
      setUsers(res.users)
    } catch (err) {
      setUsers(null)
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  async function setPlan(user, plan) {
    // Đổi gói ảnh hưởng hạn mức của người đó ngay, nên hỏi lại trước
    if (!window.confirm(`Đổi gói của ${user.email} từ ${user.plan} sang ${plan}?`)) return
    setBusy(true)
    setError('')
    setMsg('')
    try {
      const res = await adminSetPlan(await getToken(), user.uid, plan)
      setUsers((list) => list.map((u) => (u.uid === user.uid ? res.user : u)))
      setMsg(`Đã đổi ${res.user.email} sang gói ${res.user.plan}.`)
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <h2>Admin</h2>
      <p className="hint">Tìm người dùng theo email (gõ đầy đủ) rồi đổi gói thủ công.</p>
      <form onSubmit={search}>
        <label>
          Email người dùng
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} maxLength={254} required />
        </label>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Đang xử lý...' : 'Tìm'}
        </button>
      </form>

      {error && (
        <p className="msg msg-error" role="alert">
          {error}
        </p>
      )}
      {msg && (
        <p className="msg-ok" role="status">
          {msg}
        </p>
      )}
      {users && users.length === 0 && <p className="hint">Không tìm thấy người dùng nào với email này.</p>}
      {users && users.map((u) => <UserCard key={u.uid} user={u} busy={busy} onSetPlan={setPlan} />)}
    </section>
  )
}

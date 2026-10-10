// Chức năng: trang Cài đặt - tên hiển thị, giao diện (chế độ tối, cỡ chữ), đăng xuất, xóa tài khoản (có nhập lại mật khẩu).
import { useState } from 'react'
import { deleteMe } from '../services/api.js'
import { applyPrefs } from '../theme.js'
import AdminPanel from '../components/AdminPanel.jsx'

const FONT_SIZES = [
  { id: 'sm', label: 'Nhỏ' },
  { id: 'md', label: 'Vừa' },
  { id: 'lg', label: 'Lớn' },
]

// Giao diện đang hiển thị (đã áp bởi theme.js)
function currentPrefs() {
  const root = document.documentElement
  return { darkMode: root.dataset.theme === 'dark', fontSize: root.dataset.font || 'md' }
}

function deleteErrorText(err) {
  if (err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password') return 'Mật khẩu không đúng.'
  if (err.code === 'auth/too-many-requests') return 'Thử lại quá nhiều lần. Vui lòng đợi một lúc.'
  if (err.code === 'auth/network-request-failed') return 'Lỗi mạng. Kiểm tra kết nối rồi thử lại.'
  if (err.status) return err.message
  return 'Không xóa được tài khoản. Vui lòng thử lại.'
}

export default function Settings({ profile, save, getToken, reauthenticate, logout }) {
  const [prefs, setPrefs] = useState(currentPrefs)
  const [prefsMsg, setPrefsMsg] = useState('')

  const [name, setName] = useState(profile.displayName || '')
  const [nameMsg, setNameMsg] = useState('')
  const [nameBusy, setNameBusy] = useState(false)

  const [confirming, setConfirming] = useState(false)
  const [password, setPassword] = useState('')
  const [deleteError, setDeleteError] = useState('')
  const [deleteBusy, setDeleteBusy] = useState(false)

  // Đổi giao diện: áp ngay cho người dùng thấy, rồi lưu lên backend; lưu lỗi thì trả về như cũ
  async function changePrefs(patch) {
    const previous = prefs
    const next = { ...prefs, ...patch }
    setPrefs(next)
    applyPrefs(next)
    setPrefsMsg('')
    try {
      await save({ settings: patch })
    } catch {
      setPrefs(previous)
      applyPrefs(previous)
      setPrefsMsg('Chưa lưu được cài đặt. Vui lòng thử lại.')
    }
  }

  async function handleSaveName(e) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || trimmed === profile.displayName) return
    setNameBusy(true)
    setNameMsg('')
    try {
      await save({ displayName: trimmed })
      setNameMsg('Đã lưu.')
    } catch (err) {
      setNameMsg(err.message)
    } finally {
      setNameBusy(false)
    }
  }

  async function handleDelete(e) {
    e.preventDefault()
    setDeleteError('')
    setDeleteBusy(true)
    try {
      await reauthenticate(password)
      const token = await getToken(true) // token mới, mang thời điểm đăng nhập vừa xác nhận
      await deleteMe(token)
      await logout()
    } catch (err) {
      setDeleteError(deleteErrorText(err))
      setDeleteBusy(false)
    }
  }

  return (
    <>
      <h1>Cài đặt</h1>

      <form className="card" onSubmit={handleSaveName}>
        <h2>Hồ sơ</h2>
        <label>
          Tên hiển thị
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={50} required />
        </label>
        <p className="hint">Email: {profile.email}</p>
        <button className="btn btn-primary" type="submit" disabled={nameBusy}>
          {nameBusy ? 'Đang lưu...' : 'Lưu tên'}
        </button>
        {nameMsg && (
          <p className="hint" role="status">
            {nameMsg}
          </p>
        )}
      </form>

      <section className="card">
        <h2>Giao diện</h2>

        <button
          type="button"
          className="toggle-row"
          role="switch"
          aria-checked={prefs.darkMode}
          onClick={() => changePrefs({ darkMode: !prefs.darkMode })}
        >
          <span>Chế độ tối</span>
          <span className="switch" aria-hidden="true" />
        </button>

        <div>
          <p className="hint">Cỡ chữ</p>
          <div className="seg" role="group" aria-label="Cỡ chữ">
            {FONT_SIZES.map((size) => (
              <button
                key={size.id}
                type="button"
                className={`btn ${prefs.fontSize === size.id ? 'btn-primary' : 'btn-secondary'}`}
                aria-pressed={prefs.fontSize === size.id}
                onClick={() => changePrefs({ fontSize: size.id })}
              >
                {size.label}
              </button>
            ))}
          </div>
        </div>

        {prefsMsg && (
          <p className="msg msg-error" role="alert">
            {prefsMsg}
          </p>
        )}
      </section>

      {profile.isAdmin && <AdminPanel getToken={getToken} />}

      <section className="card">
        <h2>Tài khoản</h2>
        <button className="btn btn-secondary" onClick={logout}>
          Đăng xuất
        </button>

        {!confirming && (
          <button className="btn-link" onClick={() => setConfirming(true)}>
            Xóa tài khoản
          </button>
        )}

        {confirming && (
          <form onSubmit={handleDelete} className="card">
            <p className="msg msg-error">
              Tài khoản sẽ bị xóa và bạn không thể đăng nhập lại. Nhập mật khẩu để xác nhận.
            </p>
            <label>
              Mật khẩu
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            {deleteError && (
              <p className="msg msg-error" role="alert">
                {deleteError}
              </p>
            )}
            <button className="btn btn-danger" type="submit" disabled={deleteBusy}>
              {deleteBusy ? 'Đang xóa...' : 'Xác nhận xóa tài khoản'}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={deleteBusy}
              onClick={() => {
                setConfirming(false)
                setPassword('')
                setDeleteError('')
              }}
            >
              Hủy
            </button>
          </form>
        )}
      </section>
    </>
  )
}

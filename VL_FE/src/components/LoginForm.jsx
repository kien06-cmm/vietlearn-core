// Chức năng: form đăng nhập, tạo tài khoản và quên mật khẩu.
import { useState } from 'react'

export default function LoginForm({ onLogin, onRegister, onReset, initialMode = 'login', guestNote = '' }) {
  const [mode, setMode] = useState(initialMode)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)

  const isLogin = mode === 'login'
  const isReset = mode === 'reset'

  function switchMode(next) {
    setMode(next)
    setError('')
    setNotice('')
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setNotice('')
    setBusy(true)
    try {
      if (isReset) {
        await onReset(email)
        setNotice('Nếu email này đã đăng ký, bạn sẽ nhận được thư đặt lại mật khẩu.')
      } else {
        await (isLogin ? onLogin : onRegister)(email, password)
      }
    } catch (err) {
      setError(translateError(err.code))
    } finally {
      setBusy(false)
    }
  }

  const title = isReset ? 'Quên mật khẩu' : isLogin ? 'Đăng nhập' : 'Tạo tài khoản'
  const submitText = isReset ? 'Gửi thư đặt lại mật khẩu' : title

  return (
    <form className="card" onSubmit={handleSubmit}>
      <h2>{title}</h2>

      {guestNote && !isReset && <p className="hint">{guestNote}</p>}

      <label>
        Email
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
        />
      </label>

      {!isReset && (
        <label>
          Mật khẩu
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={6}
            autoComplete={isLogin ? 'current-password' : 'new-password'}
          />
        </label>
      )}

      {error && <p className="msg msg-error" role="alert">{error}</p>}
      {notice && <p className="hint" role="status">{notice}</p>}

      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? 'Đang xử lý...' : submitText}
      </button>

      {isLogin && (
        <button type="button" className="btn-link" onClick={() => switchMode('reset')}>
          Quên mật khẩu?
        </button>
      )}

      <button
        type="button"
        className="btn-link"
        onClick={() => switchMode(isLogin ? 'register' : 'login')}
      >
        {isLogin ? 'Chưa có tài khoản? Tạo tài khoản' : 'Đã có tài khoản? Đăng nhập'}
      </button>
    </form>
  )
}

// Đổi mã lỗi Firebase thành câu tiếng Việt.
function translateError(code) {
  const messages = {
    'auth/invalid-credential': 'Email hoặc mật khẩu không đúng.',
    'auth/email-already-in-use': 'Email này đã được đăng ký.',
    'auth/weak-password': 'Mật khẩu cần ít nhất 6 ký tự.',
    'auth/invalid-email': 'Email không hợp lệ.',
    'auth/too-many-requests': 'Thử lại quá nhiều lần. Vui lòng đợi một lúc.',
    'auth/network-request-failed': 'Lỗi mạng. Kiểm tra kết nối rồi thử lại.',
    'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'apiKey Firebase chưa đúng. Kiểm tra lại file .env.local.',
    'auth/invalid-api-key': 'apiKey Firebase chưa đúng. Kiểm tra lại file .env.local.',
  }
  return messages[code] || 'Không thực hiện được. Vui lòng thử lại.'
}

import { useState } from 'react'

// Form đăng nhập / tạo tài khoản bằng email và mật khẩu.
export default function LoginForm({ onLogin, onRegister }) {
  const [mode, setMode] = useState('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const isLogin = mode === 'login'

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await (isLogin ? onLogin : onRegister)(email, password)
    } catch (err) {
      setError(translateError(err.code))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form className="card" onSubmit={handleSubmit}>
      <h2>{isLogin ? 'Đăng nhập' : 'Tạo tài khoản'}</h2>

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

      {error && <p className="msg msg-error" role="alert">{error}</p>}

      <button className="btn btn-primary" type="submit" disabled={busy}>
        {busy ? 'Đang xử lý...' : isLogin ? 'Đăng nhập' : 'Tạo tài khoản'}
      </button>

      <button
        type="button"
        className="btn-link"
        onClick={() => setMode(isLogin ? 'register' : 'login')}
      >
        {isLogin ? 'Chưa có tài khoản? Tạo tài khoản' : 'Đã có tài khoản? Đăng nhập'}
      </button>
    </form>
  )
}

// Đổi mã lỗi của Firebase thành câu tiếng Việt dễ hiểu.
function translateError(code) {
  const messages = {
    'auth/invalid-credential': 'Email hoặc mật khẩu không đúng.',
    'auth/email-already-in-use': 'Email này đã được đăng ký.',
    'auth/weak-password': 'Mật khẩu cần ít nhất 6 ký tự.',
    'auth/invalid-email': 'Email không hợp lệ.',
    'auth/too-many-requests': 'Thử lại quá nhiều lần. Vui lòng đợi một lúc.',
    'auth/api-key-not-valid.-please-pass-a-valid-api-key.': 'apiKey Firebase chưa đúng. Kiểm tra lại file .env.local.',
    'auth/invalid-api-key': 'apiKey Firebase chưa đúng. Kiểm tra lại file .env.local.',
  }
  return messages[code] || 'Không thực hiện được. Vui lòng thử lại.'
}

// Chức năng: màn hình chính - hiện trạng thái backend, form đăng nhập, hồ sơ và nhắc xác minh email.
import { useEffect, useState } from 'react'
import { useAuth } from './hooks/useAuth.js'
import { getHealth, getMe, trackEvent } from './services/api.js'
import LoginForm from './components/LoginForm.jsx'
import './App.css'

function App() {
  const {
    user,
    emailVerified,
    loading,
    login,
    register,
    logout,
    resetPassword,
    resendVerification,
    refreshUser,
    getToken,
  } = useAuth()

  const [backendStatus, setBackendStatus] = useState('Đang kết nối Backend...')
  const [profile, setProfile] = useState(null)
  const [profileError, setProfileError] = useState('')
  const [verifyMsg, setVerifyMsg] = useState('')

  // Ghi 1 sự kiện 'visit' cho mỗi phiên trình duyệt (không đếm lại khi tải lại trang)
  useEffect(() => {
    if (sessionStorage.getItem('vl_visit_tracked')) return
    sessionStorage.setItem('vl_visit_tracked', '1')
    trackEvent('visit', { meta: { path: window.location.pathname } })
  }, [])

  // Kiểm tra backend còn sống
  useEffect(() => {
    getHealth()
      .then((data) => setBackendStatus(data.message))
      .catch((err) => setBackendStatus('Lỗi kết nối Backend: ' + err.message))
  }, [])

  // Tải hồ sơ từ backend sau khi đăng nhập
  useEffect(() => {
    if (!user) {
      setProfile(null)
      setProfileError('')
      return
    }
    let cancelled = false
    setProfileError('')
    getToken()
      .then((token) => getMe(token))
      .then((data) => {
        if (!cancelled) setProfile(data.user)
      })
      .catch((err) => {
        if (!cancelled) setProfileError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [user, emailVerified, getToken])

  // Đăng ký xong thì ghi sự kiện 'register' (kèm token để gắn với uid)
  async function handleRegister(email, password) {
    const cred = await register(email, password)
    const token = await cred.user.getIdToken()
    trackEvent('register', { token })
  }

  async function handleResend() {
    setVerifyMsg('')
    try {
      await resendVerification()
      setVerifyMsg('Đã gửi lại email xác minh. Kiểm tra cả mục Spam.')
    } catch {
      setVerifyMsg('Chưa gửi được. Vui lòng đợi một lúc rồi thử lại.')
    }
  }

  async function handleCheckVerified() {
    setVerifyMsg('')
    const ok = await refreshUser()
    setVerifyMsg(ok ? 'Email đã được xác minh.' : 'Chưa thấy xác minh. Hãy bấm vào link trong email trước.')
  }

  return (
    <main className="page">
      <h1>Chào mừng đến với VietLearn!</h1>
      <p className="status">Trạng thái: {backendStatus}</p>

      {loading && <p className="hint">Đang kiểm tra đăng nhập...</p>}

      {!loading && !user && (
        <LoginForm onLogin={login} onRegister={handleRegister} onReset={resetPassword} />
      )}

      {!loading && user && (
        <section className="card">
          <p>
            Xin chào <strong>{profile?.displayName || user.email}</strong>
          </p>
          <p className="hint">{user.email}</p>

          {!profile && !profileError && <p className="hint">Đang tải hồ sơ...</p>}
          {profileError && <p className="msg msg-error" role="alert">{profileError}</p>}
          {profile && <p className="hint">Gói: {profile.plan}</p>}

          {!emailVerified && (
            <>
              <p className="msg msg-error">Email chưa được xác minh. Hãy mở email và bấm vào link xác minh.</p>
              <button className="btn btn-secondary" onClick={handleResend}>
                Gửi lại email xác minh
              </button>
              <button className="btn btn-secondary" onClick={handleCheckVerified}>
                Tôi đã xác minh
              </button>
              {verifyMsg && <p className="hint" role="status">{verifyMsg}</p>}
            </>
          )}

          <button className="btn btn-secondary" onClick={logout}>
            Đăng xuất
          </button>
        </section>
      )}
    </main>
  )
}

export default App

// Chức năng: điểm vào ứng dụng - đăng nhập, rồi hiện khung ứng dụng (Dashboard, Tài liệu, Quiz, Cài đặt).
import { useEffect, useState } from 'react'
import { useAuth } from './hooks/useAuth.js'
import { useProfile } from './hooks/useProfile.js'
import { useHashRoute } from './hooks/useHashRoute.js'
import { trackEvent } from './services/api.js'
import LoginForm from './components/LoginForm.jsx'
import AppShell from './components/AppShell.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Settings from './pages/Settings.jsx'
import Documents from './pages/Documents.jsx'
import ComingSoon from './pages/ComingSoon.jsx'
import Icon from './components/Icon.jsx'
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
    reauthenticate,
  } = useAuth()
  const { profile, error: profileError, save } = useProfile(user, emailVerified, getToken)
  const route = useHashRoute()
  const [verifyMsg, setVerifyMsg] = useState('')

  // Ghi 1 sự kiện 'visit' cho mỗi phiên trình duyệt (không đếm lại khi tải lại trang)
  useEffect(() => {
    if (sessionStorage.getItem('vl_visit_tracked')) return
    sessionStorage.setItem('vl_visit_tracked', '1')
    trackEvent('visit', { meta: { path: window.location.pathname } })
  }, [])

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

  if (loading) {
    return (
      <main className="page">
        <p className="hint">Đang kiểm tra đăng nhập...</p>
      </main>
    )
  }

  if (!user) {
    return (
      <main className="page">
        <div className="login-hero">
          <span className="logo-mark logo-mark-lg">
            <Icon name="cap" size={30} />
          </span>
          <h1>Chào mừng đến với VietLearn!</h1>
          <p className="hint">Học nhanh hơn, ôn đúng chỗ yếu.</p>
        </div>
        <LoginForm onLogin={login} onRegister={handleRegister} onReset={resetPassword} />
      </main>
    )
  }

  // Không tải được hồ sơ (vd: tài khoản đã bị xóa): báo lỗi và cho đăng xuất
  if (profileError && !profile) {
    return (
      <main className="page">
        <section className="card">
          <p className="msg msg-error" role="alert">
            {profileError}
          </p>
          <button className="btn btn-secondary" onClick={logout}>
            Đăng xuất
          </button>
        </section>
      </main>
    )
  }

  return (
    <AppShell route={route} planLabel={profile?.plan}>
      {route === 'home' && (
        <Dashboard
          user={user}
          profile={profile}
          profileError={profileError}
          emailVerified={emailVerified}
          onResend={handleResend}
          onCheckVerified={handleCheckVerified}
          verifyMsg={verifyMsg}
        />
      )}
      {route === 'documents' && <Documents getToken={getToken} />}
      {route === 'quiz' && (
        <ComingSoon icon="target" title="Quiz & phòng" text="Tạo quiz, mở phòng và làm bài cùng lúc trên điện thoại. Có ở bản cập nhật sau." />
      )}
      {route === 'settings' &&
        (profile ? (
          <Settings
            key={profile.uid}
            profile={profile}
            save={save}
            getToken={getToken}
            reauthenticate={reauthenticate}
            logout={logout}
          />
        ) : (
          <p className="hint">Đang tải hồ sơ...</p>
        ))}
    </AppShell>
  )
}

export default App

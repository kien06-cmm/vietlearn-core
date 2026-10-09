// Chức năng: điểm vào ứng dụng - đăng nhập, rồi hiện khung ứng dụng (Dashboard, Tài liệu, Quiz, Cài đặt).
import { useEffect, useRef, useState } from 'react'
import { useAuth } from './hooks/useAuth.js'
import { useProfile } from './hooks/useProfile.js'
import { useHashRoute, readHashParam } from './hooks/useHashRoute.js'
import { claimGuestAttempts, trackEvent } from './services/api.js'
import { clearGuest, loadGuest } from './services/guestSession.js'
import { CreditsProvider } from './hooks/useCredits.jsx'
import LoginForm from './components/LoginForm.jsx'
import AppShell from './components/AppShell.jsx'
import BrandMark from './components/BrandMark.jsx'
import Icon from './components/Icon.jsx'
import Dashboard from './pages/Dashboard.jsx'
import Settings from './pages/Settings.jsx'
import Documents from './pages/Documents.jsx'
import Questions from './pages/Questions.jsx'
import Quizzes from './pages/Quizzes.jsx'
import Review from './pages/Review.jsx'
import RoomJoin from './components/RoomJoin.jsx'
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
  // Khách (chưa đăng nhập) vào phòng bằng mã: mở sẵn nếu địa chỉ là link phòng (#/join/MÃ)
  const [guestOpen, setGuestOpen] = useState(route === 'join')
  // Khách bấm "Tạo tài khoản để lưu kết quả": mở form đăng nhập ở chế độ tạo tài khoản
  const [signupFirst, setSignupFirst] = useState(false)
  const [claimMsg, setClaimMsg] = useState('')
  const claimedRef = useRef(false)

  // Ghi 1 sự kiện 'visit' cho mỗi phiên trình duyệt (không đếm lại khi tải lại trang)
  useEffect(() => {
    if (sessionStorage.getItem('vl_visit_tracked')) return
    sessionStorage.setItem('vl_visit_tracked', '1')
    trackEvent('visit', { meta: { path: window.location.pathname } })
  }, [])

  // Có phiên khách còn trên máy mà đã đăng nhập (vừa tạo tài khoản hoặc đăng nhập tài khoản cũ): chuyển các bài khách đã nộp sang tài khoản, một lần
  useEffect(() => {
    if (!user || claimedRef.current) return
    const guest = loadGuest()
    if (!guest) return
    claimedRef.current = true
    ;(async () => {
      try {
        const res = await claimGuestAttempts(await getToken(), guest.token)
        clearGuest()
        if (res.moved > 0) {
          setClaimMsg(`Đã lưu ${res.moved} kết quả bài làm của khách vào tài khoản. Các câu sai nằm trong mục Ôn tập.`)
        }
      } catch (err) {
        if (err.code === 'guest-expired') clearGuest() // phiên khách hết hạn: không chuyển được nữa
        else claimedRef.current = false // lỗi mạng: lần mở sau thử lại
      }
    })()
  }, [user, getToken])

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

  if (!user && guestOpen) {
    return (
      <main className="page page-guest">
        <RoomJoin
          isGuest
          initialCode={readHashParam()}
          backLabel="Đăng nhập tài khoản"
          onBack={() => {
            setGuestOpen(false)
            window.history.replaceState(null, '', '#/home')
          }}
          onCreateAccount={() => {
            setSignupFirst(true)
            setGuestOpen(false)
            window.history.replaceState(null, '', '#/home')
          }}
        />
      </main>
    )
  }

  if (!user) {
    return (
      <main className="page page-login">
        <div className="login-hero">
          <div className="login-brand">
            <BrandMark size={44} />
            <span className="wordmark wordmark-lg">
              Viet<span>Learn</span>
            </span>
          </div>
          <h1>
            Học nhanh hơn, <mark>ôn đúng chỗ yếu.</mark>
          </h1>
          <p className="lead">
            Tải tài liệu lên, AI soạn câu hỏi có dẫn nguồn từng trang. Bạn chỉ cần đọc, duyệt và ôn.
          </p>
          <ul className="login-points" aria-label="VietLearn làm được gì">
            <li>
              <Icon name="upload" size={18} />
              Tải PDF, DOCX, TXT
            </li>
            <li>
              <Icon name="spark" size={18} />
              AI soạn câu hỏi
            </li>
            <li>
              <Icon name="search" size={18} />
              Xem nguồn từng câu
            </li>
          </ul>
        </div>
        <LoginForm
          onLogin={login}
          onRegister={handleRegister}
          onReset={resetPassword}
          initialMode={signupFirst ? 'register' : 'login'}
          guestNote={loadGuest() ? 'Kết quả bài làm của khách trên máy này sẽ được lưu vào tài khoản sau khi bạn đăng nhập hoặc tạo tài khoản.' : ''}
        />
        <button className="btn btn-secondary" onClick={() => setGuestOpen(true)}>
          Vào phòng bằng mã, không cần tài khoản
        </button>
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
    <CreditsProvider user={user} getToken={getToken}>
      <AppShell route={route} planLabel={profile?.plan}>
      {claimMsg && (
        <p className="msg-ok" role="status">
          {claimMsg}
        </p>
      )}
      {route === 'home' && (
        <Dashboard
          user={user}
          profile={profile}
          profileError={profileError}
          emailVerified={emailVerified}
          onResend={handleResend}
          onCheckVerified={handleCheckVerified}
          verifyMsg={verifyMsg}
          getToken={getToken}
        />
      )}
      {route === 'documents' && <Documents getToken={getToken} />}
      {route === 'questions' && <Questions getToken={getToken} />}
      {route === 'quiz' && (
        <Quizzes getToken={getToken} />
      )}
      {route === 'review' && <Review getToken={getToken} />}
      {route === 'join' && (
        <RoomJoin
          getToken={getToken}
          initialCode={readHashParam()}
          backLabel="Quiz"
          onBack={() => {
            window.location.hash = '#/quiz'
          }}
        />
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
    </CreditsProvider>
  )
}

export default App

import { useEffect, useState } from 'react'
import { useAuth } from './hooks/useAuth.js'
import { getHealth } from './services/api.js'
import LoginForm from './components/LoginForm.jsx'
import './App.css'

function App() {
  const { user, loading, login, register, logout } = useAuth()
  const [backendStatus, setBackendStatus] = useState('Đang kết nối Backend...')

  // Kiểm tra backend trên Render còn sống không
  useEffect(() => {
    getHealth()
      .then((data) => setBackendStatus(data.message))
      .catch((err) => setBackendStatus('Lỗi kết nối Backend: ' + err.message))
  }, [])

  return (
    <main className="page">
      <h1>Chào mừng đến với VietLearn!</h1>
      <p className="status">Trạng thái: {backendStatus}</p>

      {loading && <p className="hint">Đang kiểm tra đăng nhập...</p>}

      {!loading && !user && <LoginForm onLogin={login} onRegister={register} />}

      {!loading && user && (
        <section className="card">
          <p>
            Bạn đã đăng nhập với email <strong>{user.email}</strong>
          </p>
          <button className="btn btn-secondary" onClick={logout}>
            Đăng xuất
          </button>
        </section>
      )}
    </main>
  )
}

export default App

import { useState, useEffect } from 'react'

function App() {
  const [message, setMessage] = useState('Đang kết nối Backend...')

  useEffect(() => {
    // Gọi API từ Render của bạn
    fetch('https://vietlearn-core.onrender.com/health')
      .then(res => res.json())
      .then(data => {
        setMessage(data.message)
      })
      .catch(err => {
        setMessage('Lỗi kết nối Backend: ' + err.message)
      })
  }, [])

  return (
    <div style={{ textAlign: 'center', marginTop: '50px', fontFamily: 'sans-serif' }}>
      <h1>Chào mừng đến với VietLearn!</h1>
      <p style={{ color: 'blue', fontSize: '18px' }}>Trạng thái: {message}</p>
    </div>
  )
}

export default App
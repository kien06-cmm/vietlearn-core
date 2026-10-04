import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { applyPrefs } from './theme.js'
import App from './App.jsx'

// Áp giao diện đã nhớ (tối/sáng, cỡ chữ) trước khi vẽ để không bị nháy
applyPrefs()

// Theo dõi lỗi bằng Sentry: chỉ bật khi có VITE_SENTRY_DSN (cần cài: npm install @sentry/react)
if (import.meta.env.VITE_SENTRY_DSN) {
  import('@sentry/react').then((Sentry) =>
    Sentry.init({
      dsn: import.meta.env.VITE_SENTRY_DSN,
      environment: import.meta.env.MODE,
      sendDefaultPii: false,
    }),
  )
}

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

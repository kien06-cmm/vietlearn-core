// Chức năng: kết nối realtime (WebSocket) tới một phòng làm bài (Phase 4), tự nối lại khi mất mạng.
// Đây chỉ là kênh "báo thay đổi". Dữ liệu gốc vẫn lấy bằng REST; nếu WebSocket không nối được thì giao diện quay về hỏi định kỳ như cũ.
// Giao thức xem VL_BE/realtime/wsServer.js. Mã đóng 4xxx (xác thực lỗi, không có phòng, quá tải) là lỗi cố định nên không nối lại.
import { useEffect, useRef, useState } from 'react'
import { BASE_URL } from './api.js'

const WS_URL = `${BASE_URL.replace(/^http/, 'ws')}/ws`
const MAX_BACKOFF_MS = 30_000

// code: mã phòng. getAuth(): trả token (tài khoản) hoặc 'Guest <token>' (khách). onMessage(msg) nhận { type: 'room' | 'participant', ... }.
// onOpen(): gọi mỗi lần nối (lại) thành công, dùng để đồng bộ lại dữ liệu bằng REST. Trả về true khi đang nối.
export function useRoomSocket({ code, getAuth, enabled = true, onMessage, onOpen }) {
  const [connected, setConnected] = useState(false)
  const handlers = useRef({ onMessage, onOpen })

  useEffect(() => {
    handlers.current = { onMessage, onOpen }
  })

  useEffect(() => {
    if (!enabled || !code || typeof WebSocket === 'undefined') return undefined

    let stopped = false
    let ws = null
    let timer = null
    let tries = 0

    function schedule() {
      const delay = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** tries) + Math.random() * 500
      tries += 1
      timer = setTimeout(open, delay)
    }

    async function open() {
      let auth
      try {
        auth = await getAuth()
      } catch {
        if (!stopped) schedule()
        return
      }
      if (stopped) return

      const socket = new WebSocket(WS_URL)
      ws = socket
      socket.onopen = () => {
        const header = auth.startsWith('Guest ') ? auth : `Bearer ${auth}`
        socket.send(JSON.stringify({ type: 'auth', auth: header, code }))
      }
      socket.onmessage = (e) => {
        let msg
        try {
          msg = JSON.parse(e.data)
        } catch {
          return
        }
        if (msg.type === 'ready') {
          tries = 0
          setConnected(true)
          handlers.current.onOpen?.(msg)
        } else if (msg.type === 'room' || msg.type === 'participant') {
          handlers.current.onMessage?.(msg)
        }
      }
      socket.onclose = (ev) => {
        setConnected(false)
        const fatal = ev.code >= 4000 && ev.code < 5000
        if (!stopped && !fatal) schedule()
      }
      socket.onerror = () => socket.close()
    }

    open()
    return () => {
      stopped = true
      clearTimeout(timer)
      setConnected(false)
      if (ws) {
        ws.onclose = null
        ws.close()
      }
    }
  }, [code, enabled, getAuth])

  return connected
}

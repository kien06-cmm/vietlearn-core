// Chức năng: giữ số dư AI credits cho cả ứng dụng (thanh đầu trang, Trang chủ, form tạo câu hỏi dùng chung một nguồn),
// và đồng hồ đếm ngược tới lúc credits được làm mới.
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { getCredits } from '../services/api.js'
import { resetDate } from '../services/credits.js'

const MAX_TIMEOUT = 2 ** 31 - 1 // setTimeout vượt mức này sẽ chạy ngay lập tức

const CreditsContext = createContext({ credits: null, reload: async () => {}, aiUntil: null, pauseAi: () => {} })

export function CreditsProvider({ user, getToken, children }) {
  const [credits, setCredits] = useState(null)
  const [aiUntil, setAiUntil] = useState(null) // Date: AI tạm nghỉ (Gemini quá tải) tới lúc này, dùng chung cho mọi màn hình

  // Ghi nhận AI tạm nghỉ tới `until`; không bao giờ rút ngắn mốc đang có
  const pauseAi = useCallback((until) => setAiUntil((cur) => (cur && cur > until ? cur : until)), [])

  const reload = useCallback(async () => {
    try {
      const res = await getCredits(await getToken())
      setCredits(res.credits)
      if (res.aiPause?.until) pauseAi(new Date(res.aiPause.until))
    } catch {
      // không lấy được thì thôi, backend vẫn kiểm tra quota khi dùng
    }
  }, [getToken, pauseAi])

  useEffect(() => {
    if (user) reload()
    else {
      setCredits(null)
      setAiUntil(null)
    }
  }, [user, reload])

  // Tới giờ làm mới thì tải lại số dư để giao diện báo đã có credits trở lại
  const resetAtMs = credits ? resetDate(credits).getTime() : null
  useEffect(() => {
    if (!resetAtMs) return
    const wait = resetAtMs - Date.now() + 1500
    if (wait <= 0 || wait > MAX_TIMEOUT) return
    const timer = setTimeout(reload, wait)
    return () => clearTimeout(timer)
  }, [resetAtMs, reload])

  // Quay lại tab sau một lúc (máy ngủ, tab nền bị trình duyệt làm chậm): nếu đã qua mốc làm mới thì tải lại
  useEffect(() => {
    if (!resetAtMs) return
    function onVisible() {
      if (!document.hidden && Date.now() >= resetAtMs) reload()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [resetAtMs, reload])

  return <CreditsContext.Provider value={{ credits, reload, aiUntil, pauseAi }}>{children}</CreditsContext.Provider>
}

export function useCredits() {
  return useContext(CreditsContext)
}

// Trạng thái AI tạm nghỉ: paused (đang nghỉ), left (ms còn lại), pauseAi(mốc Date) để ghi nhận khi gặp lỗi 429
export function useAiPause() {
  const { aiUntil, pauseAi } = useContext(CreditsContext)
  const left = useCountdown(aiUntil)
  return { paused: left !== null && left > 0, left: left ?? 0, pauseAi }
}

// Số mili giây còn lại tới `target` (Date). Mỗi giây cập nhật khi còn dưới 1 giờ, còn lại 30 giây một lần.
export function useCountdown(target) {
  const targetMs = target ? target.getTime() : null
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (targetMs === null) return
    let timer
    const tick = () => {
      const t = Date.now()
      setNow(t)
      const left = targetMs - t
      if (left > 0) timer = setTimeout(tick, left < 3_600_000 ? 1000 : 30_000)
    }
    tick()
    return () => clearTimeout(timer)
  }, [targetMs])

  return targetMs === null ? null : Math.max(0, targetMs - now)
}

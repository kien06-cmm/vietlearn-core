// Chức năng: giữ số dư AI credits cho cả ứng dụng (thanh đầu trang, Trang chủ, form tạo câu hỏi dùng chung một nguồn),
// và đồng hồ đếm ngược tới lúc credits được làm mới.
import { createContext, useCallback, useContext, useEffect, useState } from 'react'
import { getCredits } from '../services/api.js'
import { resetDate } from '../services/credits.js'

const MAX_TIMEOUT = 2 ** 31 - 1 // setTimeout vượt mức này sẽ chạy ngay lập tức

const CreditsContext = createContext({ credits: null, reload: async () => {} })

export function CreditsProvider({ user, getToken, children }) {
  const [credits, setCredits] = useState(null)

  const reload = useCallback(async () => {
    try {
      setCredits((await getCredits(await getToken())).credits)
    } catch {
      // không lấy được thì thôi, backend vẫn kiểm tra quota khi dùng
    }
  }, [getToken])

  useEffect(() => {
    if (user) reload()
    else setCredits(null)
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

  return <CreditsContext.Provider value={{ credits, reload }}>{children}</CreditsContext.Provider>
}

export function useCredits() {
  return useContext(CreditsContext)
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

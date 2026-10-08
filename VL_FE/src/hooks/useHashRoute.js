// Chức năng: điều hướng đơn giản bằng phần # của địa chỉ (vd: #/settings), không cần thư viện router.
import { useEffect, useState } from 'react'

export const ROUTES = ['home', 'documents', 'questions', 'quiz', 'settings', 'join']

// '#/join/ABC234' -> route 'join', phần sau là tham số (mã phòng)
function readRoute() {
  const name = window.location.hash.replace('#/', '').split('/')[0]
  return ROUTES.includes(name) ? name : 'home'
}

// Tham số sau tên trang, vd '#/join/ABC234' -> 'ABC234' (rỗng nếu không có)
export function readHashParam() {
  const raw = window.location.hash.replace('#/', '').split('/')[1] || ''
  try {
    return decodeURIComponent(raw)
  } catch {
    return ''
  }
}

export function useHashRoute() {
  const [route, setRoute] = useState(readRoute)

  useEffect(() => {
    const onChange = () => {
      setRoute(readRoute())
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])

  return route
}

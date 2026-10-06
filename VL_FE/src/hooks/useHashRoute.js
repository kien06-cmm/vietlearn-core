// Chức năng: điều hướng đơn giản bằng phần # của địa chỉ (vd: #/settings), không cần thư viện router.
import { useEffect, useState } from 'react'

export const ROUTES = ['home', 'documents', 'questions', 'quiz', 'settings']

function readRoute() {
  const name = window.location.hash.replace('#/', '')
  return ROUTES.includes(name) ? name : 'home'
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

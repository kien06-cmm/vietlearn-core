// Chức năng: tải hồ sơ người dùng từ backend sau khi đăng nhập, sửa hồ sơ/cài đặt, và áp giao diện theo cài đặt đã lưu.
import { useCallback, useEffect, useState } from 'react'
import { getMe, updateMe } from '../services/api.js'
import { applyPrefs } from '../theme.js'

export function useProfile(user, emailVerified, getToken) {
  const [profile, setProfile] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!user) {
      setProfile(null)
      setError('')
      return
    }
    let cancelled = false
    setError('')
    getToken()
      .then((token) => getMe(token))
      .then((data) => {
        if (cancelled) return
        setProfile(data.user)
        applyPrefs(data.user.settings)
      })
      .catch((err) => {
        if (!cancelled) setError(err.message)
      })
    return () => {
      cancelled = true
    }
  }, [user, emailVerified, getToken])

  // changes: { displayName?, settings?: { darkMode?, fontSize? } }
  const save = useCallback(
    async (changes) => {
      const token = await getToken()
      const data = await updateMe(token, changes)
      setProfile(data.user)
      applyPrefs(data.user.settings)
      return data.user
    },
    [getToken],
  )

  return { profile, error, save }
}

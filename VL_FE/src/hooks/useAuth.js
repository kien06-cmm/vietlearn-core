// Chức năng: quản lý đăng nhập - đăng ký, đăng nhập, đăng xuất, xác minh email, quên mật khẩu.
import { useCallback, useEffect, useState } from 'react'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  sendEmailVerification,
  sendPasswordResetEmail,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth'
import { auth } from '../config/firebase.js'

export function useAuth() {
  const [user, setUser] = useState(null)
  const [emailVerified, setEmailVerified] = useState(false)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser)
      setEmailVerified(currentUser?.emailVerified ?? false)
      setLoading(false)
    })
    return unsubscribe
  }, [])

  const register = useCallback(async (email, password) => {
    const cred = await createUserWithEmailAndPassword(auth, email, password)
    try {
      await sendEmailVerification(cred.user)
    } catch {
      // gửi lại được từ màn hình chính
    }
    return cred
  }, [])

  // Tải lại trạng thái xác minh email từ Firebase
  const refreshUser = useCallback(async () => {
    if (!auth.currentUser) return false
    await auth.currentUser.reload()
    await auth.currentUser.getIdToken(true)
    setEmailVerified(auth.currentUser.emailVerified)
    return auth.currentUser.emailVerified
  }, [])

  return {
    user,
    emailVerified,
    loading,
    login: (email, password) => signInWithEmailAndPassword(auth, email, password),
    register,
    logout: () => signOut(auth),
    resetPassword: (email) => sendPasswordResetEmail(auth, email),
    resendVerification: () => sendEmailVerification(auth.currentUser),
    refreshUser,
    getToken: () => auth.currentUser.getIdToken(),
  }
}

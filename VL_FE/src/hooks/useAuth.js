// Chức năng: quản lý đăng nhập - đăng ký, đăng nhập, đăng xuất, xác minh email, quên mật khẩu.
import { useCallback, useEffect, useState } from 'react'
import {
  createUserWithEmailAndPassword,
  EmailAuthProvider,
  onAuthStateChanged,
  reauthenticateWithCredential,
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

  // Phải bọc useCallback: nếu tạo hàm mới mỗi lần render thì useEffect trong App.jsx (phụ thuộc getToken)
  // sẽ chạy lại liên tục và gọi /me vô hạn.
  // force = true: lấy token mới từ Firebase (cần sau khi nhập lại mật khẩu để token mang thời điểm đăng nhập mới)
  const getToken = useCallback((force = false) => auth.currentUser.getIdToken(force), [])

  // Nhập lại mật khẩu để xác nhận thao tác nhạy cảm (xóa tài khoản)
  const reauthenticate = useCallback(
    (password) =>
      reauthenticateWithCredential(
        auth.currentUser,
        EmailAuthProvider.credential(auth.currentUser.email, password),
      ),
    [],
  )

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
    getToken,
    reauthenticate,
  }
}

// Theo dõi trạng thái đăng nhập và cung cấp hàm đăng nhập / đăng ký / đăng xuất.
import { useEffect, useState } from 'react'
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth'
import { auth } from '../config/firebase.js'

export function useAuth() {
  const [user, setUser] = useState(null)
  // true cho đến khi Firebase xác định xong người dùng đã đăng nhập hay chưa
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (currentUser) => {
      setUser(currentUser)
      setLoading(false)
    })
    return unsubscribe
  }, [])

  return {
    user,
    loading,
    login: (email, password) => signInWithEmailAndPassword(auth, email, password),
    register: (email, password) => createUserWithEmailAndPassword(auth, email, password),
    logout: () => signOut(auth),
  }
}

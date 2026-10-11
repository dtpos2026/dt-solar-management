import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut as fbSignOut, sendPasswordResetEmail, type User } from 'firebase/auth'
import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore'
import { auth, db, BOOTSTRAP_OWNER_EMAIL } from '../firebase'
import type { AdminDoc } from './types'
import { errorMessage } from './format'

export type AuthPhase =
  | { phase: 'loading' }
  | { phase: 'signedOut' }
  | { phase: 'checking'; user: User }
  | { phase: 'bootstrap'; user: User }
  | { phase: 'admin'; user: User; admin: AdminDoc }

interface AuthContextValue {
  state: AuthPhase
  /** Message shown on the login screen (e.g. "Not authorised"). */
  notice: string | null
  setNotice: (n: string | null) => void
  signIn: (email: string, password: string) => Promise<void>
  signOut: () => Promise<void>
  resetPassword: (email: string) => Promise<void>
  initialiseSuperAdmin: (name: string) => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

export function isBootstrapOwner(user: User | null | undefined): boolean {
  return !!user?.email && user.email.toLowerCase() === BOOTSTRAP_OWNER_EMAIL
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthPhase>({ phase: 'loading' })
  const [notice, setNotice] = useState<string | null>(null)

  const evaluateUser = useCallback(async (user: User) => {
    setState({ phase: 'checking', user })
    let adminDoc: AdminDoc | null = null
    let readError: unknown = null
    try {
      const snap = await getDoc(doc(db, 'admins', user.uid))
      if (snap.exists()) adminDoc = snap.data() as AdminDoc
    } catch (e) {
      readError = e
    }
    if (adminDoc) {
      setNotice(null)
      setState({ phase: 'admin', user, admin: adminDoc })
      return
    }
    if (isBootstrapOwner(user)) {
      setState({ phase: 'bootstrap', user })
      return
    }
    const why =
      readError && (readError as { code?: string }).code !== 'permission-denied'
        ? `Could not verify your access: ${errorMessage(readError)}`
        : `Not authorised: ${user.email ?? 'this account'} is not a Super Admin of DT Solar Pro License Control.`
    setNotice(why)
    await fbSignOut(auth)
  }, [])

  useEffect(() => {
    return onAuthStateChanged(auth, (user) => {
      if (!user) setState({ phase: 'signedOut' })
      else void evaluateUser(user)
    })
  }, [evaluateUser])

  const signIn = useCallback(async (email: string, password: string) => {
    setNotice(null)
    await signInWithEmailAndPassword(auth, email.trim(), password)
  }, [])

  const signOut = useCallback(async () => {
    await fbSignOut(auth)
  }, [])

  const resetPassword = useCallback(async (email: string) => {
    await sendPasswordResetEmail(auth, email.trim())
  }, [])

  const initialiseSuperAdmin = useCallback(
    async (name: string) => {
      const user = auth.currentUser
      if (!user || !isBootstrapOwner(user)) throw new Error('Only the owner account can initialise the Super Admin.')
      await setDoc(doc(db, 'admins', user.uid), {
        email: user.email,
        name: name.trim() || 'Digital Target',
        role: 'superadmin',
        createdAt: serverTimestamp()
      })
      await evaluateUser(user)
    },
    [evaluateUser]
  )

  const value = useMemo<AuthContextValue>(
    () => ({ state, notice, setNotice, signIn, signOut, resetPassword, initialiseSuperAdmin }),
    [state, notice, signIn, signOut, resetPassword, initialiseSuperAdmin]
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}

/** Email of the signed-in admin (used as "by" in history / audit logs). */
export function useAdminEmail(): string {
  const { state } = useAuth()
  return state.phase === 'admin' ? (state.user.email ?? state.admin.email ?? 'admin') : 'admin'
}

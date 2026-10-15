import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut as fbSignOut, sendPasswordResetEmail, type User } from 'firebase/auth'
import { doc, getDoc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore'
import { Clock } from 'lucide-react'
import { auth, db, BOOTSTRAP_OWNER_EMAIL } from '../firebase'
import type { AdminDoc } from './types'
import { errorMessage } from './format'
import { hasPerm, isOwnerRole } from './perm'
import { logActivity } from './audit'
import { clampSessionTimeout, DEFAULT_SESSION_TIMEOUT_MIN } from './branding'

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
  /** Inactivity limit in minutes (settings/portal.sessionTimeoutMin, default 30). */
  sessionTimeoutMin: number
}

const AuthContext = createContext<AuthContextValue | null>(null)

/* --------------------------------------------- inactivity --------------------------------------------- */

/** Last user activity, shared by all tabs of this browser (localStorage), so activity in one tab keeps the others alive. */
const ACTIVITY_KEY = 'dtsp-admin.lastActivity'
const TIMEOUT_LOGGED_KEY = 'dtsp-admin.timeoutLoggedAt'
const WARN_BEFORE_MS = 60_000

function readStoredMs(key: string): number | null {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? v : null
  } catch {
    return null
  }
}
function writeStored(key: string, v: number | null): void {
  try {
    if (v === null) localStorage.removeItem(key)
    else localStorage.setItem(key, String(v))
  } catch {
    /* storage blocked: the in-memory timer still works for this tab */
  }
}

export function isBootstrapOwner(user: User | null | undefined): boolean {
  return !!user?.email && user.email.toLowerCase() === BOOTSTRAP_OWNER_EMAIL
}

async function loadTimeoutMin(): Promise<number> {
  try {
    const s = await getDoc(doc(db, 'settings', 'portal'))
    return s.exists() ? clampSessionTimeout(s.data().sessionTimeoutMin) : DEFAULT_SESSION_TIMEOUT_MIN
  } catch {
    return DEFAULT_SESSION_TIMEOUT_MIN
  }
}

/** Writes a security entry but never blocks sign-out for more than ~3 s. */
async function logSecurity(action: string, details: string): Promise<void> {
  await Promise.race([
    logActivity({ action, category: 'security', target: auth.currentUser?.email ?? '', targetType: 'admin', details }).catch(() => undefined),
    new Promise((r) => setTimeout(r, 3000))
  ])
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthPhase>({ phase: 'loading' })
  const [notice, setNotice] = useState<string | null>(null)
  const [timeoutMin, setTimeoutMin] = useState(DEFAULT_SESSION_TIMEOUT_MIN)
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  /** Set by signIn(): the next admin evaluation is a fresh sign-in (logged, no stale-session check). */
  const explicitSignIn = useRef(false)
  const lastActivity = useRef(Date.now())

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
    const fresh = explicitSignIn.current
    explicitSignIn.current = false
    if (adminDoc && adminDoc.active === false) {
      setNotice(`Your admin account (${user.email ?? ''}) has been disabled. Contact the owner.`)
      await fbSignOut(auth)
      return
    }
    if (adminDoc) {
      const limitMin = await loadTimeoutMin()
      setTimeoutMin(limitMin)
      const last = readStoredMs(ACTIVITY_KEY)
      if (!fresh && last !== null && Date.now() - last > limitMin * 60_000) {
        // A remembered Firebase session restored after the inactivity limit: end it.
        await logSecurity('session_expired', `Remembered session ended: no activity for more than ${limitMin} minutes`)
        writeStored(ACTIVITY_KEY, null)
        setNotice(`Your session ended after ${limitMin} minutes of inactivity. Please sign in again.`)
        await fbSignOut(auth)
        return
      }
      lastActivity.current = Date.now()
      writeStored(ACTIVITY_KEY, lastActivity.current)
      setNotice(null)
      setState({ phase: 'admin', user, admin: adminDoc })
      if (fresh) void logSecurity('admin_signed_in', `Signed in (${navigator.userAgent.match(/(Edg|Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? 'browser'})`)
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
      if (!user) {
        setSecondsLeft(null)
        setState({ phase: 'signedOut' })
      } else void evaluateUser(user)
    })
  }, [evaluateUser])

  const uid = state.phase === 'admin' ? state.user.uid : null

  // Live admin record: permission changes apply at once; disabling or deleting the record signs the admin out.
  useEffect(() => {
    if (!uid) return
    return onSnapshot(
      doc(db, 'admins', uid),
      (s) => {
        if (!s.exists() || s.data()?.active === false) {
          setNotice(s.exists() ? 'Your admin account has been disabled. Contact the owner.' : 'Your admin record was removed. Contact the owner.')
          void fbSignOut(auth)
          return
        }
        const next = s.data() as AdminDoc
        setState((st) => (st.phase === 'admin' && JSON.stringify(st.admin) !== JSON.stringify(next) ? { ...st, admin: next } : st))
      },
      () => undefined
    )
  }, [uid])

  // Live session timeout setting.
  useEffect(() => {
    if (!uid) return
    return onSnapshot(
      doc(db, 'settings', 'portal'),
      (s) => setTimeoutMin(s.exists() ? clampSessionTimeout(s.data().sessionTimeoutMin) : DEFAULT_SESSION_TIMEOUT_MIN),
      () => undefined
    )
  }, [uid])

  // Inactivity tracking + automatic sign-out.
  useEffect(() => {
    if (!uid) return
    let lastWrite = 0
    const touch = () => {
      const now = Date.now()
      lastActivity.current = now
      if (now - lastWrite > 10_000) {
        lastWrite = now
        writeStored(ACTIVITY_KEY, now)
      }
    }
    const events = ['mousedown', 'mousemove', 'keydown', 'wheel', 'touchstart', 'scroll'] as const
    events.forEach((e) => window.addEventListener(e, touch, { passive: true, capture: true }))
    let ending = false
    const tick = async () => {
      if (ending) return
      const last = Math.max(lastActivity.current, readStoredMs(ACTIVITY_KEY) ?? 0)
      const remaining = timeoutMin * 60_000 - (Date.now() - last)
      if (remaining <= 0) {
        ending = true
        setSecondsLeft(null)
        const loggedAt = readStoredMs(TIMEOUT_LOGGED_KEY)
        if (!loggedAt || Date.now() - loggedAt > 60_000) {
          writeStored(TIMEOUT_LOGGED_KEY, Date.now())
          await logSecurity('session_timeout', `Signed out automatically after ${timeoutMin} minutes of inactivity`)
        }
        writeStored(ACTIVITY_KEY, null)
        setNotice(`You were signed out after ${timeoutMin} minutes of inactivity.`)
        await fbSignOut(auth)
        return
      }
      setSecondsLeft(remaining <= WARN_BEFORE_MS ? Math.ceil(remaining / 1000) : null)
    }
    const timer = window.setInterval(() => void tick(), 1000)
    return () => {
      window.clearInterval(timer)
      events.forEach((e) => window.removeEventListener(e, touch, { capture: true }))
    }
  }, [uid, timeoutMin])

  const signIn = useCallback(async (email: string, password: string) => {
    setNotice(null)
    explicitSignIn.current = true
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password)
    } catch (e) {
      explicitSignIn.current = false
      throw e
    }
  }, [])

  const signOut = useCallback(async () => {
    if (auth.currentUser) await logSecurity('admin_signed_out', 'Signed out')
    writeStored(ACTIVITY_KEY, null)
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
        role: 'owner',
        permissions: [],
        active: true,
        createdAt: serverTimestamp(),
        createdBy: user.email
      })
      explicitSignIn.current = true
      await evaluateUser(user)
      void logActivity({ action: 'owner_initialised', category: 'security', target: user.email ?? '', targetType: 'admin', details: 'Owner (Super Admin) record created' }).catch(() => undefined)
    },
    [evaluateUser]
  )

  const stayActive = useCallback(() => {
    lastActivity.current = Date.now()
    writeStored(ACTIVITY_KEY, lastActivity.current)
    setSecondsLeft(null)
  }, [])

  const value = useMemo<AuthContextValue>(
    () => ({ state, notice, setNotice, signIn, signOut, resetPassword, initialiseSuperAdmin, sessionTimeoutMin: timeoutMin }),
    [state, notice, signIn, signOut, resetPassword, initialiseSuperAdmin, timeoutMin]
  )
  return (
    <AuthContext.Provider value={value}>
      {children}
      {state.phase === 'admin' && secondsLeft !== null && (
        <div role="alertdialog" className="fixed right-5 bottom-5 z-[60] flex max-w-sm items-start gap-3 rounded-xl border border-amber-200 bg-white p-4 shadow-2xl">
          <Clock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="text-[13px]">
            <div className="font-bold">Still there?</div>
            <div className="text-[#6b5d85]">You will be signed out in {secondsLeft} s because of inactivity.</div>
            <button className="btn btn-primary btn-sm mt-2" onClick={stayActive}>Stay signed in</button>
          </div>
        </div>
      )}
    </AuthContext.Provider>
  )
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

/** The signed-in admin record (null while signed out). */
export function useAdmin(): (AdminDoc & { uid: string; isOwner: boolean }) | null {
  const { state } = useAuth()
  if (state.phase !== 'admin') return null
  return { ...state.admin, uid: state.user.uid, isOwner: isOwnerRole(state.admin.role) }
}

/** Permission check for the UI (the Firestore rules enforce the same permissions server side). */
export function useCan(): (perm: string) => boolean {
  const { state } = useAuth()
  const admin = state.phase === 'admin' ? state.admin : null
  return useCallback((perm: string) => hasPerm(admin, perm), [admin])
}

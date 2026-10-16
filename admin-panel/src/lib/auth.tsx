import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { onAuthStateChanged, signInWithEmailAndPassword, signOut as fbSignOut, sendPasswordResetEmail, type User } from 'firebase/auth'
import { doc, onSnapshot, serverTimestamp, setDoc, type DocumentSnapshot } from 'firebase/firestore'
import { Clock } from 'lucide-react'
import { auth, db, BOOTSTRAP_OWNER_EMAIL } from '../firebase'
import type { AdminDoc } from './types'
import { errorMessage } from './format'
import { hasPerm, isOwnerRole } from './perm'
import { logActivity } from './audit'
import { clampSessionTimeout, DEFAULT_SESSION_TIMEOUT_MIN, MIN_SESSION_TIMEOUT_MIN } from './branding'

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

/** Last known settings/portal.sessionTimeoutMin on this browser (the live value replaces it within a moment). */
const TIMEOUT_CACHE_KEY = 'dtsp-admin.sessionTimeoutMin'
function cachedTimeoutMin(): number {
  const v = readStoredMs(TIMEOUT_CACHE_KEY)
  return v === null ? DEFAULT_SESSION_TIMEOUT_MIN : clampSessionTimeout(v)
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
  const [timeoutMin, setTimeoutMin] = useState(cachedTimeoutMin)
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  /** Set by signIn(): the next admin evaluation is a fresh sign-in (logged, no stale-session check). */
  const explicitSignIn = useRef(false)
  const lastActivity = useRef(Date.now())

  /**
   * One session per Firebase user. The admins/{uid} document is read ONCE, by a live listener that serves both the
   * sign-in check and later permission changes (disabling / deleting the record signs the admin out at once).
   * settings/portal (inactivity limit) is listened to in parallel; the shell never waits for it, except when a
   * remembered session was idle longer than the shortest possible limit and the real limit decides whether it ended.
   */
  const startSession = useCallback((user: User): (() => void) => {
    let stopped = false
    let resolved = false
    let evaluating = false
    let latest: { data: AdminDoc | null; error: unknown } | null = null
    setState({ phase: 'checking', user })

    let portalStop: (() => void) | null = null
    let portalValue: Promise<number> = Promise.resolve(cachedTimeoutMin())
    const startPortal = () => {
      if (portalStop || stopped) return
      portalValue = new Promise<number>((resolve) => {
        portalStop = onSnapshot(
          doc(db, 'settings', 'portal'),
          (s) => {
            const v = s.exists() ? clampSessionTimeout(s.data().sessionTimeoutMin) : DEFAULT_SESSION_TIMEOUT_MIN
            writeStored(TIMEOUT_CACHE_KEY, v)
            setTimeoutMin(v)
            resolve(v)
          },
          () => {
            // Not an admin yet (bootstrap) or offline: keep the last known value; restarted once the admin is confirmed.
            portalStop = null
            resolve(cachedTimeoutMin())
          }
        )
      })
    }

    const evaluate = async () => {
      evaluating = true
      try {
        const first = latest
        if (!first) return
        const fresh = explicitSignIn.current
        explicitSignIn.current = false
        const adminDoc = first.data
        if (adminDoc && adminDoc.active === false) {
          setNotice(`Your admin account (${user.email ?? ''}) has been disabled. Contact the owner.`)
          await fbSignOut(auth)
          return
        }
        if (adminDoc) {
          const last = readStoredMs(ACTIVITY_KEY)
          if (!fresh && last !== null && Date.now() - last > MIN_SESSION_TIMEOUT_MIN * 60_000) {
            // A remembered Firebase session idle longer than the shortest limit: the configured limit decides.
            startPortal()
            const limitMin = await portalValue
            if (stopped) return
            if (Date.now() - last > limitMin * 60_000) {
              await logSecurity('session_expired', `Remembered session ended: no activity for more than ${limitMin} minutes`)
              writeStored(ACTIVITY_KEY, null)
              setNotice(`Your session ended after ${limitMin} minutes of inactivity. Please sign in again.`)
              await fbSignOut(auth)
              return
            }
          }
          if (stopped) return
          // The record may have changed while the limit was read.
          const now = latest?.error ? adminDoc : latest?.data ?? null
          if (!now || now.active === false) {
            setNotice(now ? 'Your admin account has been disabled. Contact the owner.' : 'Your admin record was removed. Contact the owner.')
            await fbSignOut(auth)
            return
          }
          resolved = true
          lastActivity.current = Date.now()
          writeStored(ACTIVITY_KEY, lastActivity.current)
          setNotice(null)
          setState({ phase: 'admin', user, admin: now })
          startPortal()
          if (fresh) void logSecurity('admin_signed_in', `Signed in (${navigator.userAgent.match(/(Edg|Chrome|Firefox|Safari)\/[\d.]+/)?.[0] ?? 'browser'})`)
          return
        }
        if (isBootstrapOwner(user) && !first.error) {
          // The listener stays open: creating the owner record (initialiseSuperAdmin) re-evaluates automatically.
          setState({ phase: 'bootstrap', user })
          return
        }
        const why =
          first.error && (first.error as { code?: string }).code !== 'permission-denied'
            ? `Could not verify your access: ${errorMessage(first.error)}`
            : `Not authorised: ${user.email ?? 'this account'} is not a Super Admin of DT Solar Pro License Control.`
        setNotice(why)
        await fbSignOut(auth)
      } finally {
        evaluating = false
      }
    }

    const onAdmin = (s: DocumentSnapshot) => {
      if (stopped) return
      if (!s.exists() && s.metadata.fromCache) {
        // Offline: "missing" only means "not in the local cache".
        if (!resolved) {
          latest = { data: null, error: new Error('the portal is offline — check the connection and sign in again.') }
          if (!evaluating) void evaluate()
        }
        return
      }
      const data = s.exists() ? (s.data() as AdminDoc) : null
      latest = { data, error: null }
      if (!resolved) {
        if (!evaluating) void evaluate()
        return
      }
      if (!data || data.active === false) {
        setNotice(data ? 'Your admin account has been disabled. Contact the owner.' : 'Your admin record was removed. Contact the owner.')
        void fbSignOut(auth)
        return
      }
      setState((st) => (st.phase === 'admin' && JSON.stringify(st.admin) !== JSON.stringify(data) ? { ...st, admin: data } : st))
    }
    const adminStop = onSnapshot(doc(db, 'admins', user.uid), onAdmin, (e) => {
      if (stopped || resolved) return
      latest = { data: null, error: e }
      if (!evaluating) void evaluate()
    })
    startPortal()

    return () => {
      stopped = true
      adminStop()
      portalStop?.()
      portalStop = null
    }
  }, [])

  useEffect(() => {
    let stop: (() => void) | null = null
    const unsub = onAuthStateChanged(auth, (user) => {
      stop?.()
      stop = null
      if (!user) {
        setSecondsLeft(null)
        setState({ phase: 'signedOut' })
      } else stop = startSession(user)
    })
    return () => {
      unsub()
      stop?.()
    }
  }, [startSession])

  const uid = state.phase === 'admin' ? state.user.uid : null

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
      // The live admins/{uid} listener of this session picks the new record up and opens the portal.
      explicitSignIn.current = true
      try {
        await setDoc(doc(db, 'admins', user.uid), {
          email: user.email,
          name: name.trim() || 'Digital Target',
          role: 'owner',
          permissions: [],
          active: true,
          createdAt: serverTimestamp(),
          createdBy: user.email
        })
      } catch (e) {
        explicitSignIn.current = false
        throw e
      }
      void logActivity({ action: 'owner_initialised', category: 'security', target: user.email ?? '', targetType: 'admin', details: 'Owner (Super Admin) record created' }).catch(() => undefined)
    },
    []
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

/**
 * Small shared data cache for portal pages (pure — no Firebase imports, unit tested in tests/portal-core.test.ts).
 *
 * 1. Shared live sources: one Firestore listener per key, shared by every component that needs it, kept open for
 *    a short linger period after the last subscriber leaves so going back to a page does not re-read everything.
 *    Live listeners deliver status changes immediately, so a suspended license is never shown as active.
 * 2. Cached one-shot fetches: in-flight de-duplication + short TTL, dropped by `invalidate()` after mutations.
 */

export interface SourceState<T> {
  data: T | undefined
  error: string | null
  loading: boolean
}

type Listener<T> = (s: SourceState<T>) => void
type Start<T> = (emit: (data: T) => void, fail: (error: string) => void) => () => void

interface Source<T> {
  state: SourceState<T>
  listeners: Set<Listener<T>>
  stop: (() => void) | null
  start: Start<T>
  lingerTimer: ReturnType<typeof setTimeout> | null
  lingerMs: number
}

const sources = new Map<string, Source<unknown>>()

/** Default time a listener stays open after its last subscriber left. */
export const DEFAULT_LINGER_MS = 60_000

function ensureStarted<T>(s: Source<T>) {
  if (s.stop) return
  s.state = { data: s.state.data, error: null, loading: s.state.data === undefined }
  s.stop = s.start(
    (data) => {
      s.state = { data, error: null, loading: false }
      s.listeners.forEach((l) => l(s.state))
    },
    (error) => {
      s.state = { data: s.state.data, error, loading: false }
      s.listeners.forEach((l) => l(s.state))
      // A failed listener is closed by Firestore; drop it so the next subscriber retries.
      s.stop = null
    }
  )
}

/**
 * Subscribes to a shared source. `start` is only called when no listener is open for `key`.
 * Returns the unsubscribe function; the current state is delivered synchronously.
 */
export function subscribeShared<T>(key: string, start: Start<T>, onState: Listener<T>, lingerMs = DEFAULT_LINGER_MS): () => void {
  let s = sources.get(key) as Source<T> | undefined
  if (!s) {
    s = { state: { data: undefined, error: null, loading: true }, listeners: new Set(), stop: null, start, lingerTimer: null, lingerMs }
    sources.set(key, s as Source<unknown>)
  }
  if (s.lingerTimer) {
    clearTimeout(s.lingerTimer)
    s.lingerTimer = null
  }
  s.listeners.add(onState)
  ensureStarted(s)
  onState(s.state)
  const src = s
  return () => {
    src.listeners.delete(onState)
    if (src.listeners.size === 0 && !src.lingerTimer) {
      src.lingerTimer = setTimeout(() => {
        src.lingerTimer = null
        if (src.listeners.size > 0) return
        src.stop?.()
        src.stop = null
        sources.delete(key)
      }, src.lingerMs)
    }
  }
}

/** Number of open shared listeners (diagnostics / tests). */
export function openSourceCount(): number {
  let n = 0
  sources.forEach((s) => s.stop && n++)
  return n
}

/* ---------------------------------------------- one-shot ---------------------------------------------- */

interface Entry {
  at: number
  value?: unknown
  promise?: Promise<unknown>
}
const entries = new Map<string, Entry>()
let clock: () => number = () => Date.now()

/** Test hook: replace the clock. */
export function setCacheClock(fn: () => number) {
  clock = fn
}

/** Default TTL for cached one-shot reads (kept short on purpose). */
export const DEFAULT_TTL_MS = 30_000

/** Returns a cached value younger than `ttlMs`, joins an in-flight load, or loads. Failures are not cached. */
export function cachedFetch<T>(key: string, load: () => Promise<T>, ttlMs = DEFAULT_TTL_MS): Promise<T> {
  const e = entries.get(key)
  const now = clock()
  if (e?.promise) return e.promise as Promise<T>
  if (e && 'value' in e && now - e.at < ttlMs) return Promise.resolve(e.value as T)
  const entry: Entry = { at: now }
  const p = load().then(
    (v) => {
      if (entries.get(key) === entry) {
        entry.value = v
        entry.at = clock()
        delete entry.promise
      }
      return v
    },
    (err) => {
      if (entries.get(key) === entry) entries.delete(key)
      throw err
    }
  )
  entry.promise = p
  entries.set(key, entry)
  return p
}

/** Drops cached one-shot reads whose key equals `prefix` or starts with `prefix:`; no argument = everything. */
export function invalidate(prefix?: string): void {
  for (const k of [...entries.keys()]) if (prefix === undefined || k === prefix || k.startsWith(prefix + ':')) entries.delete(k)
}

/** Test hook: forget everything (listeners are stopped). */
export function resetCache(): void {
  entries.clear()
  sources.forEach((s) => {
    if (s.lingerTimer) clearTimeout(s.lingerTimer)
    s.stop?.()
  })
  sources.clear()
}

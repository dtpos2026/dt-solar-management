/**
 * Shared Firestore data for the portal-core pages (Dashboard, Clients, Billing, Support…).
 *
 * - `useSharedDocs(key, query)`: ONE live listener per key for every component that needs it, kept open briefly after
 *   the last page leaves (queryCache linger), so moving between pages does not re-read whole collections. Being live,
 *   status changes (e.g. a license suspended by another admin) arrive immediately — nothing is shown from a stale copy.
 * - `useCachedValue(key, load)`: one-shot reads with a short TTL + in-flight de-duplication; call `invalidate(key)`
 *   after a mutation.
 * Pages map the raw documents themselves (useMemo), so different shapes share one listener.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { onSnapshot, type DocumentData, type Query, type QueryDocumentSnapshot } from 'firebase/firestore'
import { cachedFetch, invalidate, subscribeShared, type SourceState } from './queryCache'
import { loadBranding } from './brandingStore'
import { errorMessage } from './format'
import { DEFAULT_BRANDING, type Branding, type Client, type License } from './types'
import { licenseFromSnap, licensesCol } from './licenses'
import { clientFromSnap, clientsCol } from './clientsDb'

export type Snap = QueryDocumentSnapshot<DocumentData>
export interface SharedDocs {
  docs: Snap[]
  loading: boolean
  error: string | null
  retry: () => void
}
const EMPTY: Snap[] = []

/** Live documents of `makeQuery()` shared under `key`. Disabled → empty, not loading. */
export function useSharedDocs(key: string, makeQuery: () => Query<DocumentData>, enabled = true): SharedDocs {
  const [state, setState] = useState<SourceState<Snap[]>>({ data: undefined, error: null, loading: enabled })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) {
      setState({ data: undefined, error: null, loading: false })
      return
    }
    return subscribeShared<Snap[]>(
      key,
      (emit, fail) => onSnapshot(makeQuery(), (s) => emit(s.docs), (e) => fail(errorMessage(e))),
      setState
    )
    // makeQuery is identified by key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, tick])
  const retry = useCallback(() => setTick((t) => t + 1), [])
  return { docs: state.data ?? EMPTY, loading: enabled && state.loading && state.data === undefined, error: state.error, retry }
}

/** One-shot cached value (short TTL). */
export function useCachedValue<T>(key: string, load: () => Promise<T>, initial: T, enabled = true, ttlMs?: number): { value: T; loading: boolean; error: string | null; reload: () => void } {
  const [s, set] = useState<{ value: T; loading: boolean; error: string | null }>({ value: initial, loading: enabled, error: null })
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!enabled) return set({ value: initial, loading: false, error: null })
    let alive = true
    set((p) => ({ ...p, loading: true, error: null }))
    cachedFetch(key, load, ttlMs).then(
      (value) => alive && set({ value, loading: false, error: null }),
      (e) => alive && set((p) => ({ ...p, loading: false, error: errorMessage(e) }))
    )
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled, tick])
  const reload = useCallback(() => {
    invalidate(key)
    setTick((t) => t + 1)
  }, [key])
  return { ...s, reload }
}

export const BRANDING_KEY = 'branding'
/** settings/branding merged over the defaults, cached for 60 s (Settings invalidates it on save). */
export function cachedBranding(): Promise<Branding> {
  return cachedFetch(BRANDING_KEY, loadBranding, 60_000)
}
export function useSharedBranding(): Branding {
  return useCachedValue(BRANDING_KEY, loadBranding, DEFAULT_BRANDING, true, 60_000).value
}

/* ------------------------------------------ typed shared collections ------------------------------------------ */

const byCreatedDesc = <T extends { createdAt: { toMillis(): number } | null }>(a: T, b: T) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0)

export interface SharedList<T> extends SharedDocs {
  data: T[]
}

/** Every license, newest first (live, shared). */
export function useSharedLicenses(enabled = true): SharedList<License> {
  const s = useSharedDocs('licenses', licensesCol, enabled)
  const data = useMemo(() => s.docs.map(licenseFromSnap).sort(byCreatedDesc), [s.docs])
  return { ...s, data }
}

/** Every client, newest first (live, shared). */
export function useSharedClients(enabled = true): SharedList<Client> {
  const s = useSharedDocs('clients', clientsCol, enabled)
  const data = useMemo(() => s.docs.map(clientFromSnap).sort(byCreatedDesc), [s.docs])
  return { ...s, data }
}

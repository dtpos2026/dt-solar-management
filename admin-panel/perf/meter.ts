/**
 * Dev-only Firestore read meter used by perf/vite.meter.config.ts (never part of the production build).
 * Counts documents delivered by reads (≈ billed reads: a query with 0 results counts 1) and logs each read.
 */
import * as F from '@firebase/firestore'
export * from '@firebase/firestore'

type Meter = { n: number; q: number; log: string[] }
const w = window as unknown as { __reads: Meter }
w.__reads = w.__reads ?? { n: 0, q: 0, log: [] }
const add = (n: number, what: string) => {
  w.__reads.n += Math.max(1, n)
  w.__reads.q++
  w.__reads.log.push(`${Math.round(performance.now())} ${what} ${n}`)
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any
const name = (r: Any): string => r?._query?.path?.canonicalString?.() ?? r?.path ?? '?'

export const getDocs = (async (q: Any) => {
  const s = await F.getDocs(q)
  add(s.size, 'getDocs ' + name(q))
  return s
}) as typeof F.getDocs
export const getDoc = (async (r: Any) => {
  const s = await F.getDoc(r)
  add(1, 'getDoc ' + name(r))
  return s
}) as typeof F.getDoc
export const getCountFromServer = (async (q: Any) => {
  const s = await F.getCountFromServer(q)
  add(Math.max(1, Math.ceil(s.data().count / 1000)), 'count ' + name(q))
  return s
}) as typeof F.getCountFromServer
export const onSnapshot = ((ref: Any, ...args: Any[]) => {
  let first = true
  const wrap = (fn: Any) => (snap: Any) => {
    if (snap && !snap.metadata?.fromCache) {
      const n = typeof snap.docChanges === 'function' ? (first ? snap.size : snap.docChanges().length) : 1
      if (first || n) add(n, (first ? 'listen ' : 'change ') + name(ref))
      first = false
    }
    return fn(snap)
  }
  const i = args.findIndex((a) => typeof a === 'function' || (a && typeof a.next === 'function'))
  if (i >= 0) {
    if (typeof args[i] === 'function') args[i] = wrap(args[i])
    else args[i] = { ...args[i], next: wrap(args[i].next.bind(args[i])) }
  }
  return (F.onSnapshot as Any)(ref, ...args)
}) as typeof F.onSnapshot

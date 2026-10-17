import { Timestamp } from 'firebase/firestore'

export type DateLike = Timestamp | Date | string | number | null | undefined

export function toDate(v: DateLike): Date | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Timestamp) return v.toDate()
  if (v instanceof Date) return v
  if (typeof v === 'object' && v !== null && 'toDate' in (v as object)) return (v as Timestamp).toDate()
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

export function fmtDate(v: DateLike, fallback = '-'): string {
  const d = toDate(v)
  if (!d) return fallback
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

export function fmtDateTime(v: DateLike, fallback = '-'): string {
  const d = toDate(v)
  if (!d) return fallback
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function timeAgo(v: DateLike): string {
  const d = toDate(v)
  if (!d) return '-'
  const s = Math.round((Date.now() - d.getTime()) / 1000)
  if (s < 0) return fmtDateTime(d)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} day(s) ago`
  return fmtDate(d)
}

/** Days until a date (ceil). Negative = in the past. null = no date. */
export function daysUntil(v: DateLike): number | null {
  const d = toDate(v)
  if (!d) return null
  return Math.ceil((d.getTime() - Date.now()) / 86400000)
}

/** yyyy-mm-dd for <input type="date"> (local). */
export function toInputDate(d: Date | null): string {
  if (!d) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Parses yyyy-mm-dd as the END of that local day (licenses are valid through the chosen date). */
export function fromInputDate(s: string): Date | null {
  if (!s) return null
  const [y, m, d] = s.split('-').map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d, 23, 59, 59, 0)
}

export function addYears(base: Date, years: number): Date {
  const d = new Date(base.getTime())
  d.setFullYear(d.getFullYear() + years)
  d.setHours(23, 59, 59, 0)
  return d
}

export function errorMessage(e: unknown): string {
  const err = e as { code?: string; message?: string }
  const code = err?.code ?? ''
  if (code === 'permission-denied') {
    return 'Permission denied by Firestore security rules. Make sure you are signed in as a Super Admin and the latest firestore.rules are deployed.'
  }
  if (code === 'unavailable') return 'Firestore is unreachable. Check your internet connection and try again.'
  if (code === 'failed-precondition' && /index/i.test(err?.message ?? '')) return `A Firestore index is required: ${err.message}`
  if (code === 'auth/invalid-credential' || code === 'auth/wrong-password' || code === 'auth/user-not-found') return 'Incorrect email or password.'
  if (code === 'auth/too-many-requests') return 'Too many attempts. Please wait a few minutes and try again.'
  if (code === 'auth/network-request-failed') return 'Network error. Check your internet connection.'
  if (code === 'auth/invalid-email') return 'Enter a valid email address.'
  return err?.message || String(e)
}

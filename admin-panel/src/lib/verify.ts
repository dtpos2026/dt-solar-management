/**
 * Verify Key helpers (pure - no Firebase imports, unit tested in tests/portal-admin.test.ts).
 *
 * License keys look like DTSP-XXXX-XXXX-XXXX-XXXX (A–Z, 0–9). People type them with spaces, lower case,
 * typographic dashes or no dashes at all, so input is normalised before the format check.
 */

export const KEY_FORMAT_RE = /^DTSP(-[A-Z0-9]{4}){4}$/
export const KEY_PLACEHOLDER = 'DTSP-XXXX-XXXX-XXXX-XXXX'

/**
 * Normalises user input: upper case, unicode dashes → '-', separators (spaces, dots, underscores, dashes) removed
 * and re-inserted every 4 characters when the result is DTSP + 16 characters.
 */
export function normaliseKeyInput(raw: string): string {
  const up = String(raw ?? '')
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[‐-―−﹘﹣－]/g, '-')
    .trim()
  const compact = up.replace(/[\s._-]+/g, '')
  if (/^DTSP[A-Z0-9]{16}$/.test(compact)) {
    const body = compact.slice(4)
    return `DTSP-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}-${body.slice(12, 16)}`
  }
  return up.replace(/\s+/g, '')
}

export interface KeyFormatResult {
  key: string
  ok: boolean
  error: string | null
}

export function checkKeyFormat(raw: string): KeyFormatResult {
  const key = normaliseKeyInput(raw)
  if (!key) return { key, ok: false, error: 'Enter a license key.' }
  if (KEY_FORMAT_RE.test(key)) return { key, ok: true, error: null }
  if (!key.startsWith('DTSP')) return { key, ok: false, error: `License keys start with DTSP (format ${KEY_PLACEHOLDER}).` }
  const chars = key.replace(/-/g, '')
  if (/[^A-Z0-9]/.test(chars)) return { key, ok: false, error: 'Only letters A–Z and digits 0–9 are allowed.' }
  if (chars.length < 20) return { key, ok: false, error: `The key is too short - ${chars.length - 4} of 16 characters after DTSP.` }
  if (chars.length > 20) return { key, ok: false, error: `The key is too long - ${chars.length - 4} characters after DTSP (16 expected).` }
  return { key, ok: false, error: `Expected the format ${KEY_PLACEHOLDER}.` }
}

/* --------------------------------------------- status --------------------------------------------- */

export type KeyVerdict = 'active' | 'pending' | 'expired' | 'suspended' | 'revoked' | 'detached' | 'not_found' | 'invalid_format'

export interface LicenseFacts {
  status: string
  /** Expiry in epoch ms, null = lifetime. */
  expiresAtMs: number | null
  activeDevices: number
  activatedAtMs: number | null
  lastVerifiedAtMs: number | null
  detached: boolean
}

export interface VerdictInfo {
  verdict: KeyVerdict
  label: string
  /** Badge tone key understood by components/ui Badge. */
  tone: string
  valid: boolean
  explanation: string
}

const VERDICTS: Record<KeyVerdict, Omit<VerdictInfo, 'verdict'>> = {
  active: { label: 'Valid · active', tone: 'active', valid: true, explanation: 'The license is active and within its validity period.' },
  pending: { label: 'Valid · pending activation', tone: 'pending', valid: true, explanation: 'The key is valid but no computer has been activated with it yet.' },
  detached: {
    label: 'Valid · detached lifetime',
    tone: 'active',
    valid: true,
    explanation: 'A detached lifetime license works offline for ever and no longer checks in, so cloud status changes do not reach it.'
  },
  expired: { label: 'Expired', tone: 'expired', valid: false, explanation: 'The license expiry date has passed. Renew it on the Licenses page.' },
  suspended: { label: 'Suspended', tone: 'suspended', valid: false, explanation: 'The license is suspended; the desktop app locks at its next check-in.' },
  revoked: { label: 'Revoked', tone: 'revoked', valid: false, explanation: 'The license was revoked permanently.' },
  not_found: { label: 'Invalid · not found', tone: 'rejected', valid: false, explanation: 'No license with this key exists.' },
  invalid_format: { label: 'Invalid format', tone: 'rejected', valid: false, explanation: `License keys look like ${KEY_PLACEHOLDER}.` }
}

export function verdictInfo(v: KeyVerdict): VerdictInfo {
  return { verdict: v, ...VERDICTS[v] }
}

/**
 * Status shown for a found license. Order: revoked / suspended (cloud state wins), detached lifetime,
 * expired, pending (no computer ever activated), active.
 */
export function deriveVerdict(l: LicenseFacts, nowMs: number): KeyVerdict {
  if (l.status === 'revoked') return 'revoked'
  if (l.status === 'suspended') return 'suspended'
  if (l.detached) return 'detached'
  if (l.expiresAtMs !== null && l.expiresAtMs <= nowMs) return 'expired'
  if (l.activeDevices <= 0 && l.activatedAtMs === null && l.lastVerifiedAtMs === null) return 'pending'
  return 'active'
}

/** The most recent of several optional timestamps (ms); null when none is known. */
export function latestOf(...values: Array<number | null | undefined>): number | null {
  const v = values.filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
  return v.length ? Math.max(...v) : null
}

/** Parses an ISO string written by the desktop (heartbeat lastCheckAt) to ms, or null. */
export function isoToMs(iso: unknown): number | null {
  if (typeof iso !== 'string' || !iso) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}

/** "DTSP-AB12-****-****-9XYZ" - keys are shown masked in the activity log. */
export function maskKey(key: string): string {
  const m = key.match(/^DTSP-([A-Z0-9]{4})-[A-Z0-9]{4}-[A-Z0-9]{4}-([A-Z0-9]{4})$/)
  return m ? `DTSP-${m[1]}-****-****-${m[2]}` : key.length > 8 ? `${key.slice(0, 6)}…` : key
}

/* ------------------------------------------ rate limiting ------------------------------------------ */

export const VERIFY_LIMIT = 10
export const VERIFY_WINDOW_MS = 60_000

export interface RateDecision {
  allowed: boolean
  /** Lookups still allowed in the current window (after this one when allowed). */
  remaining: number
  /** Milliseconds until the next lookup is allowed (0 when allowed). */
  retryAfterMs: number
  /** Timestamps to keep (inside the window, including this attempt when allowed). */
  history: number[]
}

/**
 * Sliding-window limiter: at most `max` lookups in any `windowMs`. Browser-side only - a determined user can
 * bypass it; real server-side rate limiting would need Cloud Functions (not on the Spark plan).
 */
export function rateLimit(history: readonly number[], nowMs: number, max = VERIFY_LIMIT, windowMs = VERIFY_WINDOW_MS): RateDecision {
  const recent = history.filter((t) => typeof t === 'number' && t > nowMs - windowMs && t <= nowMs).sort((a, b) => a - b)
  if (recent.length >= max) {
    const retryAfterMs = Math.max(0, recent[recent.length - max] + windowMs - nowMs)
    return { allowed: false, remaining: 0, retryAfterMs, history: recent }
  }
  const next = [...recent, nowMs]
  return { allowed: true, remaining: max - next.length, retryAfterMs: 0, history: next }
}

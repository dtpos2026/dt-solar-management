/**
 * Consented location for the heartbeat. Modes (setting `location_sharing`):
 *  - off (default): no location is ever sent.
 *  - approximate: derived from the internet (IP) address through https://ipwho.is/ — city level, labelled
 *    "approximate", cached for 24 hours, accuracy about 25 km.
 *  - manual: coordinates typed by the customer in Settings (`location_manual`: "lat,lng" or "lat,lng | label").
 * Coordinates are never invented: when a lookup fails or the manual entry is invalid, no location is sent.
 */

export type LocationMode = 'off' | 'approximate' | 'manual'

export interface HeartbeatLocation {
  lat: number
  lng: number
  accuracyKm: number
  source: 'approximate' | 'manual'
  label: string
  consent: true
  updatedAt: string
}

export interface GeoCache {
  lat: number
  lng: number
  label: string
  fetchedAt: string
}

export const APPROX_ACCURACY_KM = 25
export const GEO_CACHE_MS = 24 * 60 * 60 * 1000
export const DEFAULT_GEOIP_URL = 'https://ipwho.is/?fields=success,message,city,region,country,latitude,longitude'

export function normalizeMode(v: unknown): LocationMode {
  return v === 'approximate' || v === 'manual' ? v : 'off'
}

export type ManualParse = { ok: true; lat: number; lng: number; accuracyKm: number; label: string } | { ok: false; error: string }

const NUM = '([-+]?\\d{1,3}(?:\\.\\d+)?)'
const COORDS_RE = new RegExp(`^${NUM}\\s*[,;]\\s*${NUM}$`)

/** Validates "lat,lng" or "lat,lng | label" typed by the customer. */
export function parseManualLocation(input: unknown): ManualParse {
  const raw = String(input ?? '').trim()
  if (!raw) return { ok: false, error: 'Enter the coordinates as latitude, longitude — for example 30.1575, 71.5249.' }
  if (raw.length > 200) return { ok: false, error: 'The location text is too long (max 200 characters).' }
  const bar = raw.indexOf('|')
  const coords = (bar >= 0 ? raw.slice(0, bar) : raw).trim()
  const label = (bar >= 0 ? raw.slice(bar + 1) : '').trim().replace(/\s+/g, ' ')
  const m = coords.match(COORDS_RE)
  if (!m) return { ok: false, error: 'Use the format latitude, longitude (decimal degrees), for example 30.1575, 71.5249 | Shop on Bosan Road.' }
  const lat = Number(m[1])
  const lng = Number(m[2])
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) return { ok: false, error: 'Latitude must be between -90 and 90.' }
  if (!Number.isFinite(lng) || lng < -180 || lng > 180) return { ok: false, error: 'Longitude must be between -180 and 180.' }
  if (lat === 0 && lng === 0) return { ok: false, error: '0, 0 is in the ocean — please enter your real coordinates.' }
  if (label.length > 120) return { ok: false, error: 'The label is too long (max 120 characters).' }
  const decimals = Math.min(decimalsOf(m[1]), decimalsOf(m[2]))
  // Precision implied by the number of decimals typed (1 decimal ≈ 11 km, 4 decimals ≈ 11 m).
  const accuracyKm = Math.max(0.001, Math.round((111.32 / Math.pow(10, decimals)) * 1000) / 1000)
  return { ok: true, lat, lng, accuracyKm, label: label || 'Entered by the customer' }
}

function decimalsOf(s: string): number {
  const i = s.indexOf('.')
  return i < 0 ? 0 : s.length - i - 1
}

/** Parses an ipwho.is response. Returns null when it does not contain usable coordinates. */
export function parseGeoIp(json: unknown, now = new Date()): GeoCache | null {
  const j = (json ?? {}) as Record<string, unknown>
  if (j.success === false) return null
  const lat = Number(j.latitude)
  const lng = Number(j.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null
  const place = [j.city, j.region, j.country].map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean)
  // City-level only: 2 decimals (≈1 km grid) is more than an IP lookup can honestly claim.
  return {
    lat: Math.round(lat * 100) / 100,
    lng: Math.round(lng * 100) / 100,
    label: `${place.length ? Array.from(new Set(place)).join(', ') : 'Internet connection'} (approximate)`.slice(0, 200),
    fetchedAt: now.toISOString()
  }
}

export function geoCacheFresh(c: GeoCache | null | undefined, now = Date.now()): boolean {
  if (!c) return false
  const t = Date.parse(c.fetchedAt)
  return Number.isFinite(t) && now - t < GEO_CACHE_MS && now >= t - 60_000
}

/** The location object sent with the heartbeat (null = none). */
export function buildLocation(
  mode: LocationMode,
  input: { manual?: string | null; manualAt?: string | null; geo?: GeoCache | null }
): HeartbeatLocation | null {
  if (mode === 'approximate') {
    const g = input.geo
    if (!g) return null
    return { lat: g.lat, lng: g.lng, accuracyKm: APPROX_ACCURACY_KM, source: 'approximate', label: g.label, consent: true, updatedAt: g.fetchedAt }
  }
  if (mode === 'manual') {
    const p = parseManualLocation(input.manual)
    if (!p.ok) return null
    return { lat: p.lat, lng: p.lng, accuracyKm: p.accuracyKm, source: 'manual', label: p.label.slice(0, 200), consent: true, updatedAt: input.manualAt || new Date().toISOString() }
  }
  return null
}

type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ status: number; json: () => Promise<unknown> }>

/** Looks up the approximate location of this internet connection (ipwho.is). Throws a readable error. */
export async function lookupApproximate(opts: { url?: string; fetchImpl?: FetchLike; timeoutMs?: number } = {}): Promise<GeoCache> {
  const f = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike)
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 10000)
  let res: Awaited<ReturnType<FetchLike>>
  try {
    res = await f(opts.url || DEFAULT_GEOIP_URL, { signal: ctrl.signal, headers: { Accept: 'application/json' } })
  } catch {
    throw new Error('Could not reach the location service (ipwho.is). Check your internet connection.')
  } finally {
    clearTimeout(t)
  }
  if (res.status !== 200) throw new Error(`The location service (ipwho.is) answered with an error (${res.status}).`)
  const g = parseGeoIp(await res.json().catch(() => null))
  if (!g) throw new Error('The location service could not determine the location of this internet connection.')
  return g
}

/**
 * Consented location for the heartbeat. Modes (setting `location_sharing`):
 *  - off (default): no location is ever sent.
 *  - approximate: derived from the internet (IP) address through https://ipwho.is/ — city level, labelled
 *    "approximate", cached for 24 hours, accuracy about 25 km.
 *  - manual: coordinates typed by the customer in Settings (`location_manual`: "lat,lng" or "lat,lng | label").
 *  - device: the Windows location service (GPS / Wi-Fi positioning) read through PowerShell
 *    (System.Device.Location.GeoCoordinateWatcher) — only when the customer chose "Use this computer's location
 *    service" and Windows location is on. Refreshed at most every 6 hours, never on every heartbeat.
 * Coordinates are never invented: when a lookup fails or the manual entry is invalid, no location is sent — there is no
 * silent fallback from one source to another (the customer chooses device | approximate | manual | off).
 */
import { execFile } from 'child_process'

export type LocationMode = 'off' | 'device' | 'approximate' | 'manual'

export interface HeartbeatLocation {
  lat: number
  lng: number
  accuracyKm: number
  source: 'device' | 'approximate' | 'manual'
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
  return v === 'device' || v === 'approximate' || v === 'manual' ? v : 'off'
}

export const LOCATION_MODES: LocationMode[] = ['off', 'device', 'approximate', 'manual']

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
  input: { manual?: string | null; manualAt?: string | null; geo?: GeoCache | null; device?: DeviceFix | null }
): HeartbeatLocation | null {
  if (mode === 'approximate') {
    const g = input.geo
    if (!g) return null
    return { lat: g.lat, lng: g.lng, accuracyKm: APPROX_ACCURACY_KM, source: 'approximate', label: g.label, consent: true, updatedAt: g.fetchedAt }
  }
  if (mode === 'device') {
    const d = input.device
    if (!d) return null
    return { lat: d.lat, lng: d.lng, accuracyKm: d.accuracyKm, source: 'device', label: DEVICE_LABEL, consent: true, updatedAt: d.fetchedAt }
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

/* ------------------------------------------ Windows location service ------------------------------------------ */

export const DEVICE_LABEL = 'Windows location service'
/** A device fix is refreshed at most this often. */
export const DEVICE_CACHE_MS = 6 * 60 * 60 * 1000
/** After a failed device read, the next attempt waits this long (never on every heartbeat). */
export const DEVICE_RETRY_MS = 60 * 60 * 1000
/** How long the PowerShell helper may run in total (it waits about 10 s for a position itself). */
export const DEVICE_TIMEOUT_MS = 25_000

export interface DeviceFix {
  lat: number
  lng: number
  accuracyKm: number
  fetchedAt: string
}

/**
 * PowerShell helper. Prints one JSON line; numbers are formatted with the invariant culture (a comma decimal separator
 * or NaN would break JSON). Waits up to ~10 s for a position.
 */
export const DEVICE_PS_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  'try {',
  '  Add-Type -AssemblyName System.Device',
  '  $w = New-Object System.Device.Location.GeoCoordinateWatcher([System.Device.Location.GeoPositionAccuracy]::High)',
  '  $deadline = (Get-Date).AddSeconds(10)',
  '  $started = $w.TryStart($true, [TimeSpan]::FromSeconds(10))',
  '  while ($started -and ($w.Status -ne "Ready" -or $w.Position.Location.IsUnknown) -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 250 }',
  '  $l = $w.Position.Location',
  '  $c = [Globalization.CultureInfo]::InvariantCulture',
  '  $o = [ordered]@{ started = [bool]$started; status = "$($w.Status)"; permission = "$($w.Permission)"; unknown = [bool]$l.IsUnknown;',
  '    lat = $l.Latitude.ToString($c); lng = $l.Longitude.ToString($c); acc = $l.HorizontalAccuracy.ToString($c) }',
  '  $w.Stop()',
  '  Write-Output ($o | ConvertTo-Json -Compress)',
  '} catch { Write-Output ((@{ error = "$($_.Exception.Message)" }) | ConvertTo-Json -Compress) }'
].join('\n')

export type DeviceParse = { ok: true; fix: DeviceFix } | { ok: false; error: string }

const UNAVAILABLE = 'Windows location is unavailable'

/** Parses the helper output (unit tested). Every failure is reported as "unavailable" with the reason. */
export function parseDeviceLocationOutput(stdout: string, now = new Date()): DeviceParse {
  const line = String(stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop()
  let j: Record<string, unknown>
  try {
    j = line ? (JSON.parse(line) as Record<string, unknown>) : {}
  } catch {
    return { ok: false, error: `${UNAVAILABLE}: unexpected answer from Windows.` }
  }
  if (typeof j.error === 'string') return { ok: false, error: `${UNAVAILABLE}: ${j.error.slice(0, 200)}` }
  if (!line) return { ok: false, error: `${UNAVAILABLE}: no answer from Windows.` }
  if (String(j.permission) === 'Denied') return { ok: false, error: `${UNAVAILABLE}: location access is turned off or denied in Windows (Settings -> Privacy -> Location).` }
  if (String(j.status) === 'Disabled') return { ok: false, error: `${UNAVAILABLE}: the Windows location service is turned off.` }
  if (j.started === false || String(j.status) === 'NoData') return { ok: false, error: `${UNAVAILABLE}: no location provider answered (no GPS / Wi-Fi positioning).` }
  const lat = Number(j.lat)
  const lng = Number(j.lng)
  const acc = Number(j.acc)
  if (j.unknown === true || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
    return { ok: false, error: `${UNAVAILABLE}: no position within 10 seconds.` }
  }
  const accuracyKm = Number.isFinite(acc) && acc > 0 ? Math.round(acc) / 1000 : 0
  return { ok: true, fix: { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, accuracyKm, fetchedAt: now.toISOString() } }
}

/** True while a device fix may be reused (refresh at most every 6 h). */
export function deviceFixFresh(f: DeviceFix | null | undefined, now = Date.now()): boolean {
  if (!f) return false
  const t = Date.parse(f.fetchedAt)
  return Number.isFinite(t) && now - t < DEVICE_CACHE_MS && now >= t - 60_000
}

export type ExecLike = (file: string, args: string[], opts: { timeout: number; windowsHide: boolean }) => Promise<string>

const defaultExec: ExecLike = (file, args, opts) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { ...opts, encoding: 'utf8', maxBuffer: 64 * 1024 }, (err, stdout) => (err && !stdout ? reject(err) : resolve(String(stdout ?? ''))))
  })

/** Reads the Windows location service once. Throws a readable "unavailable" error; never returns invented coordinates. */
export async function readDeviceLocation(opts: { exec?: ExecLike; platform?: string; timeoutMs?: number; now?: () => Date } = {}): Promise<DeviceFix> {
  if ((opts.platform ?? process.platform) !== 'win32') throw new Error(`${UNAVAILABLE}: the computer location service is only available on Windows.`)
  let out: string
  try {
    out = await (opts.exec ?? defaultExec)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', DEVICE_PS_SCRIPT], {
      timeout: opts.timeoutMs ?? DEVICE_TIMEOUT_MS,
      windowsHide: true
    })
  } catch (e) {
    const killed = (e as { killed?: boolean })?.killed
    throw new Error(killed ? `${UNAVAILABLE}: Windows did not answer in time.` : `${UNAVAILABLE}: could not start PowerShell.`)
  }
  const r = parseDeviceLocationOutput(out, opts.now?.() ?? new Date())
  if (!r.ok) throw new Error(r.error)
  return r.fix
}

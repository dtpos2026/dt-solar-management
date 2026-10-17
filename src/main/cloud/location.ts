/**
 * Device location for the Super Admin panel. Precise sources only:
 *  - The position comes from the Windows location service (GPS or Wi-Fi positioning), read through PowerShell
 *    (System.Device.Location.GeoCoordinateWatcher). The operating system decides whether the app may read it; this app never
 *    bypasses a denied permission, never guesses a position and never substitutes an internet (IP) address lookup.
 *  - Sharing needs the owner's consent (asked once, transparently, at the first sign-in of a licensed installation;
 *    withdrawable in Settings). Setting `location_sharing` is 'device' (consent given) or 'off'.
 *  - While consent is on the position is refreshed automatically (every 30 minutes, retried every 15 minutes after a failure)
 *    and sent with the heartbeat whenever the computer is online.
 */
import { execFile } from 'child_process'

export type LocationMode = 'off' | 'device'

/** Why no position is sent (shown to the customer and to the Super Admin; never shown as if it were a location). */
export type LocationStatus =
  | 'sharing' // a fresh position is being sent
  | 'not_asked' // the owner has not been asked yet
  | 'declined' // the owner chose not to share
  | 'os_denied' // Windows denies location access to desktop apps
  | 'service_off' // the Windows location service is turned off
  | 'unavailable' // no GPS / Wi-Fi positioning, or no position yet
  | 'waiting' // consent given, first reading pending

export interface HeartbeatLocation {
  lat: number
  lng: number
  accuracyKm: number
  source: 'device'
  label: string
  consent: true
  updatedAt: string
}

export function normalizeMode(v: unknown): LocationMode {
  return v === 'device' ? 'device' : 'off' // 'approximate' / 'manual' of earlier versions are gone: treated as off
}

export const LOCATION_MODES: LocationMode[] = ['off', 'device']

/* ------------------------------------------ Windows location service ------------------------------------------ */

export const DEVICE_LABEL = 'Windows location service'
/** A device fix is refreshed at most this often. */
export const DEVICE_CACHE_MS = 30 * 60 * 1000
/** After a failed device read, the next attempt waits this long (never on every heartbeat). */
export const DEVICE_RETRY_MS = 15 * 60 * 1000
/** How long the PowerShell helper may run in total (it waits about 10 s for a position itself). */
export const DEVICE_TIMEOUT_MS = 25_000

export interface DeviceFix {
  lat: number
  lng: number
  accuracyKm: number
  fetchedAt: string
}

/** What went wrong when the position could not be read. */
export type DeviceErrorKind = 'os_denied' | 'service_off' | 'unavailable'

export class DeviceLocationError extends Error {
  constructor(message: string, readonly kind: DeviceErrorKind) {
    super(message)
    this.name = 'DeviceLocationError'
  }
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

export type DeviceParse = { ok: true; fix: DeviceFix } | { ok: false; error: string; kind: DeviceErrorKind }

const UNAVAILABLE = 'Windows location is unavailable'

/** Parses the helper output (unit tested). Every failure is reported with the reason and its kind. */
export function parseDeviceLocationOutput(stdout: string, now = new Date()): DeviceParse {
  const fail = (error: string, kind: DeviceErrorKind = 'unavailable'): DeviceParse => ({ ok: false, error, kind })
  const line = String(stdout ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('{'))
    .pop()
  let j: Record<string, unknown>
  try {
    j = line ? (JSON.parse(line) as Record<string, unknown>) : {}
  } catch {
    return fail(`${UNAVAILABLE}: unexpected answer from Windows.`)
  }
  if (typeof j.error === 'string') return fail(`${UNAVAILABLE}: ${j.error.slice(0, 200)}`)
  if (!line) return fail(`${UNAVAILABLE}: no answer from Windows.`)
  if (String(j.permission) === 'Denied') return fail('Windows does not allow this app to read the location. Turn on Location and "Let desktop apps access your location" in Windows Settings, Privacy, Location.', 'os_denied')
  if (String(j.status) === 'Disabled') return fail('The Windows location service is turned off. Turn on Location in Windows Settings, Privacy, Location.', 'service_off')
  if (j.started === false || String(j.status) === 'NoData') return fail(`${UNAVAILABLE}: no location provider answered (no GPS or Wi-Fi positioning on this computer).`)
  const lat = Number(j.lat)
  const lng = Number(j.lng)
  const acc = Number(j.acc)
  if (j.unknown === true || !Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) {
    return fail(`${UNAVAILABLE}: no position within 10 seconds.`)
  }
  const accuracyKm = Number.isFinite(acc) && acc > 0 ? Math.round(acc) / 1000 : 0
  return { ok: true, fix: { lat: Math.round(lat * 1e6) / 1e6, lng: Math.round(lng * 1e6) / 1e6, accuracyKm, fetchedAt: now.toISOString() } }
}

/** True while a device fix may be reused (refresh at most every 30 minutes). */
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

/** Reads the Windows location service once. Throws a DeviceLocationError; never returns invented coordinates. */
export async function readDeviceLocation(opts: { exec?: ExecLike; platform?: string; timeoutMs?: number; now?: () => Date } = {}): Promise<DeviceFix> {
  if ((opts.platform ?? process.platform) !== 'win32') throw new DeviceLocationError(`${UNAVAILABLE}: the computer location service is only available on Windows.`, 'unavailable')
  let out: string
  try {
    out = await (opts.exec ?? defaultExec)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', DEVICE_PS_SCRIPT], {
      timeout: opts.timeoutMs ?? DEVICE_TIMEOUT_MS,
      windowsHide: true
    })
  } catch (e) {
    const killed = (e as { killed?: boolean })?.killed
    throw new DeviceLocationError(killed ? `${UNAVAILABLE}: Windows did not answer in time.` : `${UNAVAILABLE}: could not start PowerShell.`, 'unavailable')
  }
  const r = parseDeviceLocationOutput(out, opts.now?.() ?? new Date())
  if (!r.ok) throw new DeviceLocationError(r.error, r.kind)
  return r.fix
}

/** The location object sent with the heartbeat (null = none). */
export function buildLocation(mode: LocationMode, input: { device?: DeviceFix | null }): HeartbeatLocation | null {
  if (mode !== 'device' || !input.device) return null
  const d = input.device
  return { lat: d.lat, lng: d.lng, accuracyKm: d.accuracyKm, source: 'device', label: DEVICE_LABEL, consent: true, updatedAt: d.fetchedAt }
}

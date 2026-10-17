/**
 * Pure device helpers: merging license devices with heartbeats, filtering and consented locations.
 * No Firebase imports (unit tested from tests/portal-licensing.test.ts). Loading lives in fleet.ts.
 */
import { licenseBucket, onlineState, type LicenseBucket, type OnlineState } from './stats'
import { holdsSlot } from './terms'
import type { HeartbeatLocation } from './types'

export type DeviceStatus = 'active' | 'suspended' | 'revoked' | 'deactivated'
export const DEVICE_STATUS_LABEL: Record<DeviceStatus | 'unregistered', string> = {
  active: 'Active',
  suspended: 'Suspended',
  revoked: 'Revoked',
  deactivated: 'Released',
  unregistered: 'Not activated'
}

export function normaliseDeviceStatus(v: unknown): DeviceStatus {
  return v === 'suspended' || v === 'revoked' || v === 'deactivated' ? v : 'active'
}

export interface LicenseInfo {
  id: string
  licenseKey: string
  businessName: string
  customerName: string
  clientId: string
  status: string
  expiresAtMs: number | null
  activeDevices: number
  maxDevices: number
  activatedAtMs: number | null
  detached: boolean
}

export interface DeviceInfoLike {
  deviceId: string
  deviceName: string
  os: string
  appVersion: string
  status: DeviceStatus
  activatedAtMs: number | null
  activationType: string
  statusNote?: string
}

export interface HeartbeatLike {
  deviceId: string
  licenseId: string
  deviceName: string
  os: string
  appVersion: string
  companyName: string
  mode: string
  lastCheckAt: string
  lastSeenMs: number | null
  location: HeartbeatLocation | null
  locationNote?: string
  locationStatus?: string
  resetState?: string
}

export interface DeviceRow {
  key: string
  deviceId: string
  licenseId: string | null
  licenseKey: string
  company: string
  clientId: string
  deviceName: string
  os: string
  appVersion: string
  registeredMs: number | null
  lastSeenMs: number | null
  /** ISO time of the last successful license verification reported by the desktop ('' = never). */
  lastCheckAt: string
  licenseStatus: LicenseBucket | 'detached' | 'none'
  deviceStatus: DeviceStatus | 'unregistered'
  online: OnlineState
  location: HeartbeatLocation | null
  /** Why no location is shown (reported by the computer itself); '' when unknown. */
  locationNote: string
  /** Location permission state reported by the computer ('' = older app version). */
  locationStatus: string
  /** Administrator password reset progress reported by the computer ('' = none). */
  resetState: string
  mode: string
  activationType: string
  statusNote: string
}

/** Latest heartbeat per device id (a device may have several installation tokens after a reinstall). */
export function latestHeartbeats<T extends HeartbeatLike>(hbs: T[]): Map<string, T> {
  const out = new Map<string, T>()
  for (const h of hbs) {
    if (!h.deviceId) continue
    const cur = out.get(h.deviceId)
    if (!cur || (h.lastSeenMs ?? 0) > (cur.lastSeenMs ?? 0)) out.set(h.deviceId, h)
  }
  return out
}

export function licenseStatusOf(l: LicenseInfo, deviceCount: number, now: number): LicenseBucket | 'detached' {
  if (l.detached) return 'detached'
  return licenseBucket({ status: l.status, expiresAtMs: l.expiresAtMs, activeDevices: l.activeDevices, everActivated: l.activatedAtMs !== null || deviceCount > 0 }, now)
}

/**
 * One row per registered device (license × device) plus, optionally, installations that only send heartbeats
 * (trial or not yet activated). Heartbeats are matched by device id, preferring the one for the same license.
 */
export function mergeDeviceRows(
  licenses: LicenseInfo[],
  devicesByLicense: Record<string, DeviceInfoLike[]>,
  heartbeats: HeartbeatLike[],
  now = Date.now(),
  opts: { includeUnregistered?: boolean } = {}
): DeviceRow[] {
  const byDevice = latestHeartbeats(heartbeats)
  const byLicenseDevice = new Map<string, HeartbeatLike>()
  for (const h of heartbeats) {
    const k = `${h.licenseId}/${h.deviceId}`
    const cur = byLicenseDevice.get(k)
    if (!cur || (h.lastSeenMs ?? 0) > (cur.lastSeenMs ?? 0)) byLicenseDevice.set(k, h)
  }
  const rows: DeviceRow[] = []
  const seen = new Set<string>()
  for (const l of licenses) {
    const devs = devicesByLicense[l.id] ?? []
    const lstat = licenseStatusOf(l, devs.length, now)
    for (const d of devs) {
      const hb = byLicenseDevice.get(`${l.id}/${d.deviceId}`) ?? byDevice.get(d.deviceId) ?? null
      seen.add(d.deviceId)
      rows.push({
        key: `${l.id}/${d.deviceId}`,
        deviceId: d.deviceId,
        licenseId: l.id,
        licenseKey: l.licenseKey,
        company: l.businessName || l.customerName || hb?.companyName || '',
        clientId: l.clientId,
        deviceName: d.deviceName || hb?.deviceName || '',
        os: hb?.os || d.os,
        appVersion: hb?.appVersion || d.appVersion,
        registeredMs: d.activatedAtMs,
        lastSeenMs: hb?.lastSeenMs ?? null,
        lastCheckAt: hb?.lastCheckAt ?? '',
        licenseStatus: lstat,
        deviceStatus: d.status,
        online: onlineState(hb?.lastSeenMs ?? null, now),
        location: hb ? validLocation(hb.location) : null,
        locationNote: hb?.locationNote ?? '',
        locationStatus: hb?.locationStatus ?? '',
        resetState: hb?.resetState ?? '',
        mode: hb?.mode ?? '',
        activationType: d.activationType,
        statusNote: d.statusNote ?? ''
      })
    }
  }
  if (opts.includeUnregistered) {
    const licById = new Map(licenses.map((l) => [l.id, l]))
    for (const h of byDevice.values()) {
      if (seen.has(h.deviceId)) continue
      const l = h.licenseId ? licById.get(h.licenseId) : undefined
      rows.push({
        key: `hb/${h.deviceId}`,
        deviceId: h.deviceId,
        licenseId: l ? l.id : null,
        licenseKey: l?.licenseKey ?? '',
        company: h.companyName || l?.businessName || '',
        clientId: l?.clientId ?? '',
        deviceName: h.deviceName,
        os: h.os,
        appVersion: h.appVersion,
        registeredMs: null,
        lastSeenMs: h.lastSeenMs,
        lastCheckAt: h.lastCheckAt,
        licenseStatus: l ? licenseStatusOf(l, 1, now) : 'none',
        deviceStatus: 'unregistered',
        online: onlineState(h.lastSeenMs, now),
        location: validLocation(h.location),
        locationNote: h.locationNote ?? '',
        locationStatus: h.locationStatus ?? '',
        resetState: h.resetState ?? '',
        mode: h.mode,
        activationType: '',
        statusNote: ''
      })
    }
  }
  return rows
}

/** Slots used on a license = devices that are active, suspended or revoked. */
export function slotsUsed(devs: Array<{ status: string }>): number {
  return devs.filter((d) => holdsSlot(d.status)).length
}

/** Returns the location only when it is a consented, in-range point. Never invents coordinates. */
export function validLocation(loc: unknown): HeartbeatLocation | null {
  if (!loc || typeof loc !== 'object') return null
  const l = loc as Partial<HeartbeatLocation>
  if (l.consent !== true) return null
  if (typeof l.lat !== 'number' || typeof l.lng !== 'number' || !Number.isFinite(l.lat) || !Number.isFinite(l.lng)) return null
  if (l.lat < -90 || l.lat > 90 || l.lng < -180 || l.lng > 180) return null
  // Only a position read from the device itself (GPS / Wi-Fi) is a location. Older apps also sent an internet-address guess
  // ('approximate') or a typed point ('manual'): those are not shown as a device position.
  if (l.source !== 'device') return null
  return {
    lat: l.lat,
    lng: l.lng,
    accuracyKm: typeof l.accuracyKm === 'number' && Number.isFinite(l.accuracyKm) && l.accuracyKm > 0 ? l.accuracyKm : undefined,
    source: l.source,
    label: typeof l.label === 'string' ? l.label : undefined,
    consent: true,
    updatedAt: typeof l.updatedAt === 'string' ? l.updatedAt : undefined
  }
}

export interface DeviceFilter {
  q: string
  online: '' | OnlineState
  deviceStatus: '' | DeviceStatus | 'unregistered'
  licenseStatus: '' | LicenseBucket | 'detached' | 'none'
}

export function filterDeviceRows(rows: DeviceRow[], f: DeviceFilter): DeviceRow[] {
  const q = f.q.trim().toLowerCase()
  return rows.filter((r) => {
    if (f.online && r.online !== f.online) return false
    if (f.deviceStatus && r.deviceStatus !== f.deviceStatus) return false
    if (f.licenseStatus && r.licenseStatus !== f.licenseStatus) return false
    if (q) {
      const t = `${r.company} ${r.deviceName} ${r.deviceId} ${r.licenseKey} ${r.os} ${r.appVersion} ${r.location?.label ?? ''}`.toLowerCase()
      if (!t.includes(q)) return false
    }
    return true
  })
}

/** Sort: online first, then most recently seen, then company. */
export function sortDeviceRows(rows: DeviceRow[]): DeviceRow[] {
  const rank: Record<OnlineState, number> = { online: 0, recent: 1, offline: 2, never: 3 }
  return [...rows].sort((a, b) => rank[a.online] - rank[b.online] || (b.lastSeenMs ?? 0) - (a.lastSeenMs ?? 0) || a.company.localeCompare(b.company))
}

/* ------------------------------------------------ location display ------------------------------------------------ */

export type LocationSource = HeartbeatLocation['source'] | 'unavailable'

/** Source label shown next to every location. IP locations are never called precise. */
export const LOCATION_SOURCE_LABEL: Record<LocationSource, string> = {
  device: 'Device location service',
  approximate: 'Approximate (internet IP) — usually the ISP’s city',
  manual: 'Manual (entered by the customer)',
  unavailable: 'Unavailable'
}

export function locationSource(loc: HeartbeatLocation | null | undefined): LocationSource {
  return loc ? loc.source : 'unavailable'
}

/** Accuracy radius in metres ('device' points report metres; IP points are kilometres wide), null when unknown. */
export function accuracyMetres(loc: HeartbeatLocation | null | undefined): number | null {
  if (!loc || !loc.accuracyKm || !(loc.accuracyKm > 0)) return null
  return Math.round(loc.accuracyKm * 1000)
}

/** "±35 m" for device fixes, "±25 km" for IP / manual points, '' when unknown. */
export function accuracyText(loc: HeartbeatLocation | null | undefined): string {
  const m = accuracyMetres(loc)
  if (m === null) return ''
  if (loc!.source === 'device' && m < 10_000) return `±${m.toLocaleString('en-US')} m`
  const km = m / 1000
  return `±${km >= 10 ? Math.round(km) : Math.round(km * 10) / 10} km`
}

/* ------------------------------------------------ location permission ------------------------------------------------ */

/** What the computer reports about its location permission. Shown as a status, never as if it were a place. */
export const LOCATION_STATUS_LABEL: Record<string, string> = {
  sharing: 'Sharing',
  not_asked: 'Owner not asked yet',
  declined: 'Declined by the owner',
  os_denied: 'Blocked by Windows',
  service_off: 'Windows location is off',
  unavailable: 'No position available',
  waiting: 'Waiting for the first position'
}

export function locationStatusLabel(r: Pick<DeviceRow, 'locationStatus' | 'lastSeenMs' | 'location'>): string {
  if (r.location) return LOCATION_STATUS_LABEL.sharing
  if (!r.lastSeenMs) return 'Computer has not connected yet'
  return LOCATION_STATUS_LABEL[r.locationStatus] ?? 'Not reported by this app version'
}

/**
 * Device heartbeat: heartbeats/{installToken}. Shape and limits follow admin-panel/DATA_MODEL.md and
 * firestore.rules (validHeartbeat). `lastSeen` is set by the server (REQUEST_TIME), never by this computer.
 */
import { double, type Write } from './firestore'
import type { HeartbeatLocation } from './location'

export interface HeartbeatInput {
  deviceId: string
  licenseId: string | null | undefined
  deviceName: string
  os: string
  appVersion: string
  companyName: string | null | undefined
  mode: string
  lastCheckAt: string | null | undefined
  firms: number
  users: number
  location: HeartbeatLocation | null
}

/** Exactly the fields written (except lastSeen, which the server sets). */
export interface HeartbeatPayload {
  deviceId: string
  licenseId: string
  deviceName: string
  os: string
  appVersion: string
  companyName: string
  mode: string
  lastCheckAt: string
  firms: number
  users: number
  location?: HeartbeatLocation
}

const cut = (v: unknown, max: number): string => String(v ?? '').slice(0, max)
const count = (n: unknown): number => {
  const v = Math.floor(Number(n))
  return Number.isFinite(v) && v >= 0 ? v : 0
}

export function buildHeartbeat(i: HeartbeatInput): HeartbeatPayload {
  const p: HeartbeatPayload = {
    deviceId: cut(i.deviceId, 64),
    licenseId: cut(i.licenseId ?? '', 64),
    deviceName: cut(i.deviceName, 200),
    os: cut(i.os, 200),
    appVersion: cut(i.appVersion, 40),
    companyName: cut(i.companyName ?? '', 200),
    mode: cut(i.mode, 30),
    lastCheckAt: cut(i.lastCheckAt ?? '', 40),
    firms: count(i.firms),
    users: count(i.users)
  }
  if (i.location) {
    const l = i.location
    p.location = {
      lat: l.lat,
      lng: l.lng,
      accuracyKm: l.accuracyKm,
      source: l.source,
      label: cut(l.label, 200),
      consent: true,
      updatedAt: cut(l.updatedAt, 40)
    }
  }
  return p
}

/**
 * The commit write. The whole document is replaced (no update mask) so switching location sharing off removes the
 * previous location from the cloud as well.
 */
export function heartbeatWrite(token: string, p: HeartbeatPayload): Write {
  const fields: Record<string, unknown> = { ...p }
  if (p.location) {
    fields.location = { ...p.location, lat: double(p.location.lat), lng: double(p.location.lng), accuracyKm: double(p.location.accuracyKm) }
  }
  return { path: `heartbeats/${token}`, fields, serverTime: ['lastSeen'] }
}

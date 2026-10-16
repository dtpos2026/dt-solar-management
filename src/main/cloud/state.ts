/** Small JSON state file for the online features (kept in the license folder next to install.json). */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { DeviceFix, GeoCache } from './location'
import type { HeartbeatPayload } from './heartbeat'
import type { SyncState } from './support'

export interface HeartbeatRecord {
  lastAttemptAt: string | null
  lastOkAt: string | null
  ok: boolean | null
  error: string | null
  /** What was sent last time (for "exactly what is sent"). */
  lastPayload: HeartbeatPayload | null
}

export interface SupportRecord extends SyncState {
  lastSyncAt?: string | null
  lastOkAt?: string | null
  ok?: boolean | null
  offline?: boolean
  error?: string | null
  warning?: string | null
}

export interface CloudState {
  heartbeat: HeartbeatRecord
  geo: GeoCache | null
  geoError: string | null
  /** When the customer last changed the manual location (sent as location.updatedAt). */
  manual: { value: string; at: string } | null
  /** Last Windows location service fix, error and attempt time (refresh at most every 6 h). */
  device: DeviceFix | null
  deviceError: string | null
  deviceAttemptAt: string | null
  support: SupportRecord
}

export function emptyState(): CloudState {
  return {
    heartbeat: { lastAttemptAt: null, lastOkAt: null, ok: null, error: null, lastPayload: null },
    geo: null,
    geoError: null,
    manual: null,
    device: null,
    deviceError: null,
    deviceAttemptAt: null,
    support: {}
  }
}

export function loadCloudState(dir: string): CloudState {
  try {
    const j = JSON.parse(readFileSync(join(dir, 'cloud.json'), 'utf8')) as Partial<CloudState>
    const e = emptyState()
    return {
      heartbeat: { ...e.heartbeat, ...(j.heartbeat ?? {}) },
      geo: j.geo ?? null,
      geoError: j.geoError ?? null,
      manual: j.manual ?? null,
      device: j.device ?? null,
      deviceError: j.deviceError ?? null,
      deviceAttemptAt: j.deviceAttemptAt ?? null,
      support: { ...(j.support ?? {}) }
    }
  } catch {
    return emptyState()
  }
}

export function saveCloudState(dir: string, s: CloudState): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'cloud.json')
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(s, null, 2))
  renameSync(tmp, file)
}

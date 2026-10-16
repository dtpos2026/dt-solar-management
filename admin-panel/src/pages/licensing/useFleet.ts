/** Loads licenses (with their devicesSummary) + heartbeats in parallel and merges them into device rows (no N+1). */
import { useCallback, useEffect, useState } from 'react'
import { useCan } from '../../lib/auth'
import { heartbeatLike, licenseInfo, loadDeviceInfos, loadHeartbeats, loadLicenses } from '../../lib/fleet'
import { mergeDeviceRows, type DeviceRow } from '../../lib/devices'
import { errorMessage } from '../../lib/format'
import type { License } from '../../lib/types'
import { DEVICE_READ_PERMS, HEARTBEAT_READ_PERMS } from './hooks'

export interface Fleet {
  rows: DeviceRow[]
  licenses: License[]
  loading: boolean
  error: string | null
  loadedAt: number
  /** false when the admin may not read heartbeats (online status unknown). */
  heartbeats: boolean
  refresh: () => void
}

export function useFleet(enabled = true, includeUnregistered = true): Fleet {
  const can = useCan()
  const canDevices = DEVICE_READ_PERMS.some(can)
  const canHb = HEARTBEAT_READ_PERMS.some(can)
  const backfill = can('devices.manage')
  const [tick, setTick] = useState(0)
  const [s, set] = useState<Omit<Fleet, 'refresh' | 'heartbeats'>>({ rows: [], licenses: [], loading: true, error: null, loadedAt: 0 })
  useEffect(() => {
    if (!enabled || !canDevices) return set({ rows: [], licenses: [], loading: false, error: null, loadedAt: Date.now() })
    let alive = true
    set((p) => ({ ...p, loading: true, error: null }))
    ;(async () => {
      // Licenses and heartbeats are independent: read in parallel. Refresh (tick > 0) bypasses the licenses cache.
      const [licenses, hbs] = await Promise.all([loadLicenses({ fresh: tick > 0 }), canHb ? loadHeartbeats() : Promise.resolve([])])
      const byLic = await loadDeviceInfos(licenses, { backfill })
      const now = Date.now()
      const rows = mergeDeviceRows(licenses.map(licenseInfo), byLic, hbs.map(heartbeatLike), now, { includeUnregistered })
      if (alive) set({ rows, licenses, loading: false, error: null, loadedAt: now })
    })().catch((e) => alive && set((p) => ({ ...p, loading: false, error: errorMessage(e) })))
    return () => {
      alive = false
    }
  }, [enabled, canDevices, canHb, includeUnregistered, backfill, tick])
  const refresh = useCallback(() => setTick((t) => t + 1), [])
  return { ...s, heartbeats: canHb, refresh }
}

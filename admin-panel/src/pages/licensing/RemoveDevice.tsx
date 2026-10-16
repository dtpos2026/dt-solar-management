/** "Remove device" confirmation shared by the Devices page and the Device map, plus immediate hiding of removed rows. */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { deleteHeartbeatsOf, removeDevice } from '../../lib/deletions'
import { DEVICE_STATUS_LABEL, type DeviceRow } from '../../lib/devices'
import { maskDeviceId, maskLicenseKey } from '../../lib/terms'
import { useAdminEmail } from '../../lib/auth'
import { ConfirmDialog, type ConfirmOptions, type NoticeTone } from './kit'

export interface RemovedInfo {
  row: DeviceRow
  /** The row is gone (record / heartbeat deleted) — hide it now. */
  deleted: boolean
  text: string
  tone: NoticeTone
}

/**
 * Rows minus the ones just removed. A removed key stays hidden until a load without it arrives, so a marker or row
 * disappears at once and cannot come back from a load that started before the removal.
 */
export function useRemovedRows(rows: DeviceRow[], loading: boolean): { visible: DeviceRow[]; hide: (key: string) => void } {
  const [removed, setRemoved] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (loading) return
    setRemoved((prev) => {
      if (!prev.size) return prev
      const keys = new Set(rows.map((r) => r.key))
      const next = new Set([...prev].filter((k) => keys.has(k)))
      return next.size === prev.size ? prev : next
    })
  }, [rows, loading])
  const visible = useMemo(() => (removed.size ? rows.filter((r) => !removed.has(r.key)) : rows), [rows, removed])
  const hide = useCallback((key: string) => setRemoved((prev) => new Set(prev).add(key)), [])
  return { visible, hide }
}

export function RemoveDeviceDialog({ row, onClose, onDone }: { row: DeviceRow | null; onClose: () => void; onDone: (r: RemovedInfo) => void }) {
  const by = useAdminEmail()
  const [deleteRecord, setDeleteRecord] = useState(true)
  useEffect(() => setDeleteRecord(true), [row?.key])
  if (!row) return <ConfirmDialog opts={null} onClose={onClose} />
  const r = row
  const name = r.deviceName || maskDeviceId(r.deviceId)
  const unregistered = r.deviceStatus === 'unregistered' || !r.licenseId
  const holds = r.deviceStatus === 'active' || r.deviceStatus === 'suspended' || r.deviceStatus === 'revoked'
  const key = r.licenseKey ? maskLicenseKey(r.licenseKey) : 'its license'
  const opts: ConfirmOptions = {
    title: `Remove device “${name}”`,
    confirmLabel: 'Remove device',
    tone: 'danger',
    reason: !unregistered,
    reasonLabel: 'Note',
    body: unregistered ? (
      <p>
        This computer was never activated — it only sends heartbeats{r.company ? ` (${r.company})` : ''}. Its heartbeat record is deleted, so it disappears from the
        Devices list and the map. If the app keeps running there, it shows up again with its next heartbeat.
      </p>
    ) : (
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Status now: <b>{DEVICE_STATUS_LABEL[r.deviceStatus]}</b>{r.company ? ` · ${r.company}` : ''} · license {key}.
        </li>
        {holds ? (
          <li>It is <b>released</b> first: its slot is freed and it is added to the deactivated list, so it becomes read-only at its next check-in.</li>
        ) : (
          <li>It is already released (it does not hold a slot).</li>
        )}
        <li>The license history and the activity log record the removal.</li>
      </ul>
    ),
    extra: !unregistered && (
      <label className="flex items-start gap-2 text-[13px]">
        <input type="checkbox" className="mt-0.5" checked={deleteRecord} onChange={(e) => setDeleteRecord(e.target.checked)} />
        <span>
          Also delete the device record and its heartbeat — it disappears from the Devices list and the map (it stays on the deactivated list). Untick to only
          release it.
        </span>
      </label>
    ),
    run: async (note) => {
      if (unregistered) {
        const n = await deleteHeartbeatsOf(r.deviceId, null)
        onDone({ row: r, deleted: true, text: `${name}: ${n} heartbeat record(s) deleted.`, tone: 'success' })
        return
      }
      const res = await removeDevice(r.licenseId!, r.deviceId, by, { deleteRecord, note })
      const parts = [res.released ? 'released (slot freed; read-only at its next check-in)' : 'was already released', res.deleted ? 'record deleted' : 'record kept']
      onDone({
        row: r,
        deleted: res.deleted,
        text: `${name}: ${parts.join(', ')}.${res.warnings.length ? ` ${res.warnings.join(' ')}` : ''}`,
        tone: res.warnings.length ? 'warn' : 'success'
      })
    }
  }
  return <ConfirmDialog opts={opts} onClose={onClose} />
}

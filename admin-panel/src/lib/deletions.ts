/**
 * Destructive admin actions with their clean-up: deleting a whole license (owner) and removing a computer.
 *
 * License delete order (rules: an ACTIVE device record may only be deleted by the owner once its license no longer
 * exists after the write, see firestore.rules):
 *   0. activationPasses/{sha256(key)} (public pass, if any)
 *   1. pre-batches: license history, non-active device records, pending activation requests (rejected)
 *   2. final batch: the license, licenseStatus/{id}, active device records and the 'license_deleted' audit entry
 * A failure before step 2 leaves the license in place, so the delete can simply be run again.
 * Every batch holds at most DELETE_BATCH_SIZE writes.
 */
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  serverTimestamp,
  where,
  writeBatch,
  type DocumentReference
} from 'firebase/firestore'
import { auth, db } from '../firebase'
import { sha256Hex } from './crypto'
import { isOwnerRole } from './perm'
import {
  deactivateDeviceInTx,
  deviceFromSnap,
  deviceLabel,
  deviceRef,
  devicesCol,
  historyCol,
  invalidateLicenses,
  licenseFromSnap,
  licenseRef,
  licenseStatusRef,
  requestsCol,
  summaryPatch,
  writeAudit,
  writeLog
} from './licenses'
import { planLicenseHistoryClear } from './clearing'
import { planClearBatches } from './auditLog'
import { heartbeatsCol } from './fleet'
import { holdsSlot } from './terms'
import { invalidate } from './queryCache'
import type { License } from './types'

export const DELETE_BATCH_SIZE = 400

/** Document id of the public activation pass of a license key: lowercase hex SHA-256 of the upper-case key. */
export async function activationPassId(licenseKey: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(licenseKey.trim().toUpperCase()))
}
export const activationPassRef = (id: string) => doc(db, 'activationPasses', id)

export interface LicenseDeletePreview {
  devices: { ref: DocumentReference; deviceId: string; deviceName: string; active: boolean; holdsSlot: boolean }[]
  history: DocumentReference[]
  /** Pending activation requests for this key / license (they are answered as rejected). */
  requests: { ref: DocumentReference; type: string }[]
  /** Invoices that mention the license (kept), null when the admin may not read invoices. */
  invoices: number | null
}

/** Reads everything that belongs to a license (devices, history, pending requests, invoices). */
export async function licenseDeletePreview(l: License, opts: { invoices: boolean }): Promise<LicenseDeletePreview> {
  const [devSnap, hist, byKey, byId, inv] = await Promise.all([
    getDocs(devicesCol(l.id)),
    planLicenseHistoryClear(l.id),
    l.licenseKey ? getDocs(query(requestsCol(), where('licenseKey', '==', l.licenseKey))) : Promise.resolve(null),
    getDocs(query(requestsCol(), where('licenseId', '==', l.id))),
    opts.invoices ? getDocs(query(collection(db, 'invoices'), where('licenseId', '==', l.id))) : Promise.resolve(null)
  ])
  const requests = new Map<string, { ref: DocumentReference; type: string }>()
  for (const s of [...(byKey?.docs ?? []), ...byId.docs]) {
    if (s.data().status === 'pending') requests.set(s.id, { ref: s.ref, type: String(s.data().type ?? 'activate') })
  }
  return {
    devices: devSnap.docs.map((s) => {
      const d = deviceFromSnap(s)
      return { ref: s.ref, deviceId: d.deviceId, deviceName: d.deviceName, active: d.status === 'active', holdsSlot: holdsSlot(d.status) }
    }),
    history: hist.refs,
    requests: [...requests.values()],
    invoices: inv ? inv.size : null
  }
}

export interface LicenseDeleteResult {
  devices: number
  history: number
  requests: number
  /** true = removed (or there was none), false = could not be removed (see warnings) */
  activationPass: boolean
  warnings: string[]
}

type Op = { ref: DocumentReference; update?: Record<string, unknown> }

async function commitOps(ops: Op[], extra?: (b: ReturnType<typeof writeBatch>) => void): Promise<void> {
  const b = writeBatch(db)
  for (const o of ops) {
    if (o.update) b.update(o.ref, o.update)
    else b.delete(o.ref)
  }
  extra?.(b)
  await b.commit()
}

/**
 * Deletes a license and everything that belongs to it (owner only - the rules allow nobody else): devices, history,
 * licenseStatus, the public activation pass and pending activation requests (answered as rejected). The client keeps
 * existing (the link lived on the license); invoices are kept. One 'license_deleted' audit entry is written with the
 * license removal. Computers that were activated keep their certificate but can no longer check in.
 */
export async function deleteLicense(l: License, by: string, reason = '', opts: { invoices?: boolean } = {}): Promise<LicenseDeleteResult> {
  // Owner only (the rules refuse the license delete to anyone else): check first, so nobody else can clear the
  // history / released devices of a license and then be refused the delete itself.
  const uid = auth.currentUser?.uid
  const me = uid ? await getDoc(doc(db, 'admins', uid)) : null
  if (!me?.exists() || me.data()?.active === false || !isOwnerRole(String(me.data()?.role ?? ''))) throw new Error('Only the owner can delete a license.')
  const p = await licenseDeletePreview(l, { invoices: !!opts.invoices })
  const warnings: string[] = []

  // 0. Public activation pass (doc id = sha256 of the key). Removed first so the key cannot be used meanwhile.
  let activationPass = true
  if (l.licenseKey) {
    try {
      await deleteDoc(activationPassRef(await activationPassId(l.licenseKey)))
    } catch (e) {
      const code = (e as { code?: string }).code ?? ''
      if (code !== 'permission-denied') throw e
      activationPass = false
      warnings.push('The activation pass of this key could not be removed (not allowed by the security rules).')
    }
  }

  // 1. Everything that may be deleted while the license still exists.
  const msg = 'This license key was deleted by Digital Target. Contact Digital Target for a new key.'
  const pre: Op[] = [
    ...p.history.map((ref) => ({ ref })),
    ...p.devices.filter((d) => !d.active).map((d) => ({ ref: d.ref })),
    ...p.requests.map((r) => ({
      ref: r.ref,
      update: r.type === 'deactivate'
        ? { status: 'processed', message: msg, processedAt: serverTimestamp(), processedBy: by }
        : { status: 'rejected', message: msg, processedAt: serverTimestamp(), processedBy: by }
    }))
  ]
  for (const part of planClearBatches(pre, DELETE_BATCH_SIZE)) await commitOps(part)

  // 2. The license itself with licenseStatus, the active device records and the audit entry (same batch).
  const active = p.devices.filter((d) => d.active).map((d) => ({ ref: d.ref }))
  const room = DELETE_BATCH_SIZE - 3
  const first = active.slice(0, room)
  const details =
    `License ${l.licenseKey} (${l.businessName || l.customerName || '-'}) deleted: ${p.devices.length} computer record(s) (${active.length} active), ` +
    `${p.history.length} history entr${p.history.length === 1 ? 'y' : 'ies'}, ${p.requests.length} pending request(s) answered` +
    `${l.clientId ? `; unlinked from client ${l.clientId}` : ''}${p.invoices ? `; ${p.invoices} invoice(s) kept` : ''}` +
    `${activationPass ? '' : '; activation pass NOT removed'}${reason.trim() ? `. Reason: ${reason.trim()}` : ''}`
  await commitOps([{ ref: licenseRef(l.id) }, { ref: licenseStatusRef(l.id) }, ...first], (b) => writeAudit(b, 'license_deleted', by, l.id, details, 'license'))
  // Any further active device records (only for licenses with hundreds of computers): the license is gone now.
  for (const part of planClearBatches(active.slice(room), DELETE_BATCH_SIZE)) await commitOps(part)

  // 3. Records written meanwhile (e.g. a history entry added by another admin during the delete). The license is
  //    gone, so the owner may remove them; a failure here is reported, the license itself is already deleted.
  try {
    const [devLeft, histLeft] = await Promise.all([getDocs(devicesCol(l.id)), getDocs(historyCol(l.id))])
    const left = [...devLeft.docs, ...histLeft.docs].map((d) => ({ ref: d.ref }))
    for (const part of planClearBatches(left, DELETE_BATCH_SIZE)) await commitOps(part)
  } catch (e) {
    warnings.push(`Some records of the deleted license could not be removed: ${(e as Error).message}`)
  }

  invalidateLicenses()
  invalidate('licenses')
  return { devices: p.devices.length, history: p.history.length, requests: p.requests.length, activationPass, warnings }
}

/* ---------------------------------------------- remove a computer ---------------------------------------------- */

export interface RemoveDeviceResult {
  /** The computer held a slot and was released (slot freed, added to licenseStatus.deactivatedDevices). */
  released: boolean
  /** The device record (and its heartbeat for this license) was deleted. */
  deleted: boolean
  heartbeats: number
  warnings: string[]
}

/** Deletes the heartbeat documents of a computer (all of them, or only those reporting `licenseId`). */
export async function deleteHeartbeatsOf(deviceId: string, licenseId: string | null): Promise<number> {
  const snap = await getDocs(query(heartbeatsCol(), where('deviceId', '==', deviceId)))
  const refs = snap.docs.filter((d) => licenseId === null || String(d.data().licenseId ?? '') === licenseId).map((d) => d.ref)
  for (const part of planClearBatches(refs, DELETE_BATCH_SIZE)) await commitOps(part.map((ref) => ({ ref })))
  return refs.length
}

/**
 * "Remove device" (devices.manage). A computer holding a slot (active / suspended / revoked) is released first with
 * the normal release flow - slot freed, added to licenseStatus.deactivatedDevices, history + audit. With
 * `deleteRecord` the released record is then deleted, dropped from license.devicesSummary, and its heartbeat for this
 * license is deleted so it disappears from the Devices list and the map. The computer stays in deactivatedDevices.
 */
export async function removeDevice(licenseId: string, deviceId: string, by: string, o: { deleteRecord: boolean; note?: string }): Promise<RemoveDeviceResult> {
  const note = (o.note ?? '').trim()
  // 1. Release (separate transaction: the rules only let a non-active record be deleted).
  const released = await runTransaction(db, async (tx) => {
    const licSnap = await tx.get(licenseRef(licenseId))
    const devSnap = await tx.get(deviceRef(licenseId, deviceId))
    if (!licSnap.exists()) throw new Error('License not found.')
    if (!devSnap.exists()) throw new Error('Device not found (already removed?).')
    return deactivateDeviceInTx(tx, licenseFromSnap(licSnap), devSnap, deviceId, by, 'by admin (remove device)', note)
  })
  invalidateLicenses()
  if (!o.deleteRecord) return { released, deleted: false, heartbeats: 0, warnings: [] }

  // 2. Delete the record and drop it from the license's device summary.
  await runTransaction(db, async (tx) => {
    const licSnap = await tx.get(licenseRef(licenseId))
    const devSnap = await tx.get(deviceRef(licenseId, deviceId))
    if (!devSnap.exists()) return
    if (holdsSlot(String(devSnap.data()?.status ?? 'active'))) throw new Error('The computer was reactivated in the meantime; it was not deleted.')
    const dev = deviceFromSnap(devSnap)
    tx.delete(deviceRef(licenseId, deviceId))
    if (licSnap.exists()) {
      const lic = licenseFromSnap(licSnap)
      const patch = summaryPatch(lic, {})
      if (patch.devicesSummary) delete (patch.devicesSummary as Record<string, unknown>)[deviceId]
      tx.update(licenseRef(licenseId), { ...patch, updatedAt: serverTimestamp() })
      writeLog(tx, licenseId, 'device_removed', by, `${deviceLabel(dev.deviceName, deviceId)} record removed (stays on the deactivated list)${note ? `. Note: ${note}` : ''}`, 'device')
    }
  })
  invalidateLicenses()

  // 3. Its heartbeat for this license (otherwise it would come back as a "not activated" row).
  const warnings: string[] = []
  let heartbeats = 0
  try {
    heartbeats = await deleteHeartbeatsOf(deviceId, licenseId)
  } catch (e) {
    warnings.push(`The device record was deleted, but its heartbeat could not be removed: ${(e as Error).message}`)
  }
  return { released, deleted: true, heartbeats, warnings }
}

/**
 * Activation approval and certificate publishing — runs in the admin's browser (no Cloud Functions on the Spark plan).
 * Registers/reactivates the device in a transaction, signs the certificate with the local key,
 * and (for online requests) writes the activation code back to activationRequests/{id}.
 * After a change of terms, publishCertificates re-signs every ACTIVE device and publishes the codes to
 * licenseStatus/{id}.certs[deviceId]; the desktop installs its own one at the next check-in.
 */
import { getDoc, getDocs, runTransaction, serverTimestamp, writeBatch } from 'firebase/firestore'
import { db } from '../firebase'
import { signPayload, verifyCode, type LicensePayload, type LoadedKey, type SignedCertificate } from './crypto'
import {
  deactivateDeviceInTx,
  deviceFromSnap,
  deviceLabel,
  deviceRef,
  devicesCol,
  findLicenseByKey,
  licenseFromSnap,
  licenseRef,
  licenseStatusPatch,
  licenseStatusRef,
  requestRef,
  summaryEntry,
  summaryPatch,
  writeAudit,
  writeLog
} from './licenses'
import { buildCertPayload, classifyActivation, replaceableError, type CertTerms } from './terms'
import type { ActivationRequest, Device, License } from './types'

export interface DeviceInfo {
  deviceId: string
  deviceName: string
  os: string
  appVersion: string
}

export function certTermsOf(l: License): CertTerms {
  return {
    licenseId: l.id,
    customerName: l.customerName,
    businessName: l.businessName,
    phone: l.phone,
    email: l.email,
    plan: l.plan,
    planType: l.planType,
    clientId: l.clientId,
    maxFirms: l.maxFirms,
    maxUsers: l.maxUsers,
    maxDevices: l.maxDevices,
    features: l.features,
    expiresAtMs: l.expiresAt ? l.expiresAt.toMillis() : null,
    graceDays: l.graceDays,
    checkinDays: l.checkinDays,
    poweredBy: l.poweredBy,
    detached: l.detached
  }
}

export function buildPayload(l: License, deviceId: string): LicensePayload {
  return buildCertPayload(certTermsOf(l), deviceId)
}

async function signFor(l: License, deviceId: string, key: LoadedKey): Promise<SignedCertificate> {
  const cert = await signPayload(buildPayload(l, deviceId), key.seed)
  if (!(await verifyCode(cert.code, key.publicKey))) throw new Error('Signature self-check failed. Reload the signing key.')
  return cert
}

/** Signs the certificate of one computer for a license read inside a transaction (used when a computer is reactivated). */
export function deviceCertSigner(key: LoadedKey, deviceId: string): (lic: License) => Promise<string> {
  return async (lic) => (await signFor(lic, deviceId, key)).code
}

export function dtlicName(l: Pick<License, 'businessName' | 'customerName'>, deviceId: string): string {
  return `${(l.businessName || l.customerName || 'license').replace(/[^\w-]+/g, '_')}-${deviceId.slice(0, 9)}.dtlic`
}

export interface IssueOptions {
  /**
   * The license's device limit is full: release this computer and give its slot to the new one in the SAME
   * transaction (explicit admin choice "Replace device X with this one").
   */
  replaceDeviceId?: string
  /** Note recorded with a reassignment. */
  note?: string
  /** Pending activation request to approve in the SAME transaction (certificate + request + slot are one atomic write). */
  requestId?: string
  /** Client to link when the license has none yet (same transaction). */
  clientId?: string
  clientLabel?: string
}

/** Thrown when the limit is full and no computer to replace was chosen; the request stays pending. */
export class NeedsReassignmentError extends Error {
  constructor(public slotsUsed: number, public maxDevices: number) {
    super(`Device limit reached (${slotsUsed} of ${maxDevices}). Reject the request or replace a computer with this one.`)
    this.name = 'NeedsReassignmentError'
  }
}

/**
 * A business refusal (invalid key, license not usable, computer suspended / revoked, cannot replace): an online
 * request is rejected with this message. Any other error (network, permission, signing) leaves it pending.
 */
export class ActivationRefusedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ActivationRefusedError'
  }
}

/** The request was answered by someone else (or the customer cancelled it) before this approval committed. */
export class RequestProcessedError extends Error {
  constructor() {
    super('This request has already been processed.')
    this.name = 'RequestProcessedError'
  }
}

export interface IssueResult {
  license: License
  cert: SignedCertificate
  kind: 'new' | 'reissue' | 'reassign'
}

/**
 * Validates and registers the device, returns the signed certificate. Throws a human readable error to reject.
 * Only ever called on an explicit admin action (approve / reassign / offline activation / re-issue): a valid key
 * alone never grants a slot through the admin path. Everything happens in ONE transaction (reads in parallel, one
 * commit): slot, device record, summary, history, the certificate published to licenseStatus.certs and — for an online
 * request — the approval written back to activationRequests/{id}. The customer's app therefore sees the approval at the
 * moment the slot exists, with no further round trips. The transaction re-reads everything, so two approvals racing for
 * the last slot cannot both succeed (the loser is retried by Firestore, sees the full limit and fails).
 */
export async function issueForDevice(
  licenseKey: string,
  dev: DeviceInfo,
  key: LoadedKey,
  by: string,
  activationType: 'online' | 'offline' | 'instant',
  opts: IssueOptions = {}
): Promise<IssueResult> {
  const found = await findLicenseByKey(licenseKey)
  if (!found) throw new ActivationRefusedError('Invalid license key')
  const replaceId = opts.replaceDeviceId?.trim() || ''
  const { license, kind, cert } = await runTransaction(db, async (tx) => {
    const [licSnap, devSnap, oldSnap, statusSnap, reqSnap] = await Promise.all([
      tx.get(licenseRef(found.id)),
      tx.get(deviceRef(found.id, dev.deviceId)),
      replaceId ? tx.get(deviceRef(found.id, replaceId)) : Promise.resolve(null),
      replaceId ? tx.get(licenseStatusRef(found.id)) : Promise.resolve(null),
      opts.requestId ? tx.get(requestRef(opts.requestId)) : Promise.resolve(null)
    ])
    if (reqSnap && (!reqSnap.exists() || reqSnap.data()?.status !== 'pending')) throw new RequestProcessedError()
    if (!licSnap.exists()) throw new ActivationRefusedError('Invalid license key')
    const lic = licenseFromSnap(licSnap)
    const existing = devSnap.exists() ? deviceFromSnap(devSnap) : null
    const plan = classifyActivation(
      { status: lic.status, expiresAtMs: lic.expiresAt ? lic.expiresAt.toMillis() : null, activeDevices: lic.activeDevices, maxDevices: lic.maxDevices },
      existing ? existing.status : null
    )
    if (plan.kind === 'invalid') throw new ActivationRefusedError(plan.reason)
    const label = deviceLabel(dev.deviceName, dev.deviceId)
    const base = { deviceId: dev.deviceId, deviceName: dev.deviceName, os: dev.os, appVersion: dev.appVersion, lastIssuedAt: serverTimestamp(), activationType }
    const link = opts.clientId && !lic.clientId ? { clientId: opts.clientId } : {}
    const linkLog = () => {
      if (link.clientId) writeLog(tx, lic.id, 'client_linked', by, `License linked to client ${opts.clientLabel ?? opts.clientId} on activation approval`, 'client')
    }
    const approveRequestDoc = (code: string) => {
      if (opts.requestId) tx.update(requestRef(opts.requestId), { status: 'approved', certificate: code, licenseId: lic.id, processedAt: serverTimestamp(), processedBy: by })
    }
    if (plan.kind === 'reissue') {
      const signed = await signFor(lic, dev.deviceId, key)
      tx.update(deviceRef(lic.id, dev.deviceId), base)
      tx.update(licenseRef(lic.id), {
        ...summaryPatch(lic, { [dev.deviceId]: summaryEntry({ ...existing!, ...dev, activatedAt: devSnap.data()?.activatedAt ?? null, status: 'active', activationType }) }),
        ...link,
        updatedAt: serverTimestamp()
      })
      tx.set(licenseStatusRef(lic.id), { certs: { [dev.deviceId]: signed.code }, updatedAt: serverTimestamp() }, { merge: true })
      writeLog(tx, lic.id, 'certificate_reissued', by, `${label} — certificate re-issued (${activationType}); no new slot used`, 'license')
      linkLog()
      approveRequestDoc(signed.code)
      return { license: lic, kind: 'reissue' as const, cert: signed }
    }
    let activeDevices = lic.activeDevices
    const changes: Record<string, Record<string, unknown>> = {}
    let outcome: 'new' | 'reassign' = 'new'
    let replacedName = ''
    if (plan.kind === 'reassign') {
      if (!replaceId) throw new NeedsReassignmentError(plan.slotsUsed, plan.maxDevices)
      const old = oldSnap && oldSnap.exists() ? deviceFromSnap(oldSnap) : null
      const err = replaceableError(old ? { deviceId: old.deviceId, status: old.status } : null, dev.deviceId)
      if (err) throw new ActivationRefusedError(err)
      replacedName = old!.deviceName
      // Release the replaced computer (slot freed) — same transaction as the activation below.
      tx.update(deviceRef(lic.id, replaceId), { status: 'deactivated', deactivatedAt: serverTimestamp(), statusChangedAt: serverTimestamp(), statusBy: by, statusNote: (opts.note ?? '').trim() || `Replaced by ${dev.deviceName || 'another computer'}` })
      changes[replaceId] = summaryEntry({ ...old!, activatedAt: oldSnap!.data()?.activatedAt ?? null, status: 'deactivated', statusNote: `Replaced by ${dev.deviceName || 'another computer'}` })
      activeDevices -= 1
      outcome = 'reassign'
    }
    // (A slot freed up meanwhile: the chosen computer is NOT released — the request simply takes the free slot.)
    activeDevices += 1
    if (activeDevices > lic.maxDevices) throw new Error(`Device limit reached (${lic.activeDevices} of ${lic.maxDevices})`)
    const signed = await signFor({ ...lic, activeDevices }, dev.deviceId, key)
    tx.set(deviceRef(lic.id, dev.deviceId), { ...base, status: 'active', activatedAt: serverTimestamp(), deactivatedAt: null, statusNote: '', statusChangedAt: serverTimestamp(), statusBy: by }, { merge: true })
    tx.update(licenseRef(lic.id), {
      activeDevices,
      ...summaryPatch(lic, { ...changes, [dev.deviceId]: summaryEntry({ ...dev, status: 'active', activatedAt: serverTimestamp(), activationType }) }),
      ...link,
      updatedAt: serverTimestamp(),
      ...(lic.activatedAt ? {} : { activatedAt: serverTimestamp() })
    })
    if (outcome === 'reassign') {
      // One write: the replaced computer joins deactivatedDevices, the new one leaves it, the old cert is dropped.
      const prev = statusSnap?.data()?.deactivatedDevices
      const deactivated = Array.from(new Set([...(Array.isArray(prev) ? prev.filter((x): x is string => typeof x === 'string') : []), replaceId])).filter((x) => x !== dev.deviceId)
      tx.set(licenseStatusRef(lic.id), { ...licenseStatusPatch(lic, undefined, [replaceId]), deactivatedDevices: deactivated, certs: { [dev.deviceId]: signed.code } }, { merge: true })
      writeLog(
        tx,
        lic.id,
        'device_reassigned',
        by,
        `${deviceLabel(replacedName, replaceId)} released and replaced by ${label} (${activationType}) — slots ${activeDevices} of ${lic.maxDevices}${opts.note?.trim() ? `. Note: ${opts.note.trim()}` : ''}`,
        'license'
      )
    } else {
      tx.set(licenseStatusRef(lic.id), { ...licenseStatusPatch(lic, { remove: [dev.deviceId] }), certs: { [dev.deviceId]: signed.code } }, { merge: true })
      writeLog(tx, lic.id, 'device_activated', by, `${label} approved and activated (${activationType}) — slots ${activeDevices} of ${lic.maxDevices}`, 'license')
    }
    linkLog()
    approveRequestDoc(signed.code)
    return { license: { ...lic, activeDevices }, kind: outcome, cert: signed }
  })
  return { license, cert, kind }
}

export interface PublishedCert {
  deviceId: string
  deviceName: string
  code: string
  fileContents: string
  fileName: string
}

/**
 * Re-signs certificates for every ACTIVE device of the license with the loaded key and publishes them to
 * licenseStatus/{id}.certs (+ status, expiry, poweredBy, detached). Certificates of devices that no longer
 * hold an active slot are removed from the map. Writes history + audit.
 */
export async function publishCertificates(licenseId: string, key: LoadedKey, by: string, reason: string): Promise<{ license: License; certs: PublishedCert[] }> {
  const licSnap = await getDoc(licenseRef(licenseId))
  if (!licSnap.exists()) throw new Error('License not found.')
  const license = licenseFromSnap(licSnap)
  const devSnaps = await getDocs(devicesCol(licenseId))
  const devices: Device[] = devSnaps.docs.map(deviceFromSnap)
  const active = devices.filter((d) => d.status === 'active')
  const certs: PublishedCert[] = []
  const issuedAt = new Date()
  for (const d of active) {
    const cert = await signPayload(buildCertPayload(certTermsOf(license), d.deviceId, issuedAt), key.seed)
    if (!(await verifyCode(cert.code, key.publicKey))) throw new Error('Signature self-check failed. Reload the signing key.')
    certs.push({ deviceId: d.deviceId, deviceName: d.deviceName, code: cert.code, fileContents: cert.fileContents, fileName: dtlicName(license, d.deviceId) })
  }
  const map: Record<string, unknown> = {}
  for (const c of certs) map[c.deviceId] = c.code
  const batch = writeBatch(db)
  const patch = licenseStatusPatch(license, undefined, devices.filter((d) => d.status !== 'active').map((d) => d.deviceId))
  batch.set(licenseStatusRef(licenseId), { ...patch, certs: { ...((patch.certs as Record<string, unknown>) ?? {}), ...map } }, { merge: true })
  for (const c of certs) batch.update(deviceRef(licenseId, c.deviceId), { lastIssuedAt: serverTimestamp() })
  writeLog(
    batch,
    licenseId,
    'certificates_published',
    by,
    `${certs.length} certificate(s) re-signed and published${license.detached ? ' (detached, no check-in)' : ''}${reason ? ` after: ${reason}` : ''}`
  )
  await batch.commit()
  return { license, certs }
}

export type ApproveOutcome = 'approved' | 'reissued' | 'reassigned' | 'rejected' | 'processed' | 'needs_reassignment'

/**
 * Approves one pending request on an explicit admin action. A full device limit does NOT reject the request:
 * it returns 'needs_reassignment' and the request stays pending until the admin rejects it or replaces a computer.
 */
export async function approveRequest(
  req: ActivationRequest,
  key: LoadedKey,
  by: string,
  opts: { clientId?: string; clientLabel?: string; replaceDeviceId?: string; note?: string } = {}
): Promise<ApproveOutcome> {
  if (req.type === 'deactivate') {
    await runTransaction(db, async (tx) => {
      const reqSnap = await tx.get(requestRef(req.id))
      if (!reqSnap.exists() || reqSnap.data()?.status !== 'pending') return
      if (req.licenseId) {
        const [licSnap, devSnap] = await Promise.all([tx.get(licenseRef(req.licenseId)), tx.get(deviceRef(req.licenseId, req.deviceId))])
        if (licSnap.exists()) deactivateDeviceInTx(tx, licenseFromSnap(licSnap), devSnap, req.deviceId, by, 'by the customer')
      }
      tx.update(requestRef(req.id), { status: 'processed', processedAt: serverTimestamp(), processedBy: by })
    })
    return 'processed'
  }
  try {
    const { kind } = await issueForDevice(req.licenseKey ?? '', req, key, by, 'online', {
      replaceDeviceId: opts.replaceDeviceId,
      note: opts.note,
      requestId: req.id,
      clientId: opts.clientId,
      clientLabel: opts.clientLabel
    })
    return kind === 'reissue' ? 'reissued' : kind === 'reassign' ? 'reassigned' : 'approved'
  } catch (e) {
    if (e instanceof RequestProcessedError) return 'processed'
    if (e instanceof NeedsReassignmentError) return 'needs_reassignment'
    if (!(e instanceof ActivationRefusedError)) throw e
    await rejectRequest(req, e.message, by)
    return 'rejected'
  }
}

/** Rejects a request; recorded in the license history + activity log (license category) when the license is known. */
export async function rejectRequest(req: ActivationRequest, message: string, by: string): Promise<void> {
  const text = message || 'Rejected by Digital Target'
  let licenseId = req.licenseId || ''
  if (!licenseId && req.licenseKey) licenseId = (await findLicenseByKey(req.licenseKey).catch(() => null))?.id ?? ''
  const batch = writeBatch(db)
  batch.update(requestRef(req.id), { status: 'rejected', message: text, processedAt: serverTimestamp(), processedBy: by })
  const details = `${req.type === 'deactivate' ? 'Release' : 'Activation'} request from ${deviceLabel(req.deviceName, req.deviceId)} rejected: ${text}`
  if (licenseId) writeLog(batch, licenseId, 'activation_rejected', by, details, 'license')
  else writeAudit(batch, 'activation_rejected', by, null, `${details} (no license with this key)`, 'license')
  await batch.commit()
}

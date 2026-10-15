/**
 * Activation approval and certificate publishing — runs in the admin's browser (no Cloud Functions on the Spark plan).
 * Registers/reactivates the device in a transaction, signs the certificate with the local key,
 * and (for online requests) writes the activation code back to activationRequests/{id}.
 * After a change of terms, publishCertificates re-signs every ACTIVE device and publishes the codes to
 * licenseStatus/{id}.certs[deviceId]; the desktop installs its own one at the next check-in.
 */
import { getDoc, getDocs, runTransaction, serverTimestamp, setDoc, updateDoc, writeBatch } from 'firebase/firestore'
import { db } from '../firebase'
import { signPayload, verifyCode, type LicensePayload, type LoadedKey, type SignedCertificate } from './crypto'
import {
  deactivateDeviceInTx,
  deviceFromSnap,
  deviceRef,
  devicesCol,
  findLicenseByKey,
  isExpired,
  licenseFromSnap,
  licenseRef,
  licenseStatusPatch,
  licenseStatusRef,
  requestRef,
  writeLog
} from './licenses'
import { buildCertPayload, type CertTerms } from './terms'
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

export function dtlicName(l: Pick<License, 'businessName' | 'customerName'>, deviceId: string): string {
  return `${(l.businessName || l.customerName || 'license').replace(/[^\w-]+/g, '_')}-${deviceId.slice(0, 9)}.dtlic`
}

/** Validates and registers the device, returns the signed certificate. Throws a human readable error to reject. */
export async function issueForDevice(licenseKey: string, dev: DeviceInfo, key: LoadedKey, by: string, activationType: 'online' | 'offline'): Promise<{ license: License; cert: SignedCertificate }> {
  const found = await findLicenseByKey(licenseKey)
  if (!found) throw new Error('Invalid license key')
  const license = await runTransaction(db, async (tx) => {
    const licSnap = await tx.get(licenseRef(found.id))
    const devSnap = await tx.get(deviceRef(found.id, dev.deviceId))
    if (!licSnap.exists()) throw new Error('Invalid license key')
    const lic = licenseFromSnap(licSnap)
    if (lic.status === 'suspended') throw new Error('License is suspended')
    if (lic.status === 'revoked') throw new Error('License is revoked')
    if (isExpired(lic)) throw new Error('License expired')
    const existing = devSnap.exists() ? deviceFromSnap(devSnap) : null
    if (existing?.status === 'suspended') throw new Error('This computer is suspended. Contact Digital Target.')
    if (existing?.status === 'revoked') throw new Error('This computer has been revoked. Contact Digital Target.')
    const base = { deviceId: dev.deviceId, deviceName: dev.deviceName, os: dev.os, appVersion: dev.appVersion, lastIssuedAt: serverTimestamp(), activationType }
    if (existing && existing.status === 'active') {
      tx.update(deviceRef(lic.id, dev.deviceId), base)
      writeLog(tx, lic.id, 'certificate_reissued', by, `${dev.deviceName || 'Device'} (${dev.deviceId}) — ${activationType}`, 'device')
      return lic
    }
    if (lic.activeDevices >= lic.maxDevices) throw new Error(`Device limit reached (${lic.activeDevices} of ${lic.maxDevices})`)
    tx.set(deviceRef(lic.id, dev.deviceId), { ...base, status: 'active', activatedAt: serverTimestamp(), deactivatedAt: null, statusNote: '', statusChangedAt: serverTimestamp(), statusBy: by }, { merge: true })
    tx.update(licenseRef(lic.id), { activeDevices: lic.activeDevices + 1, updatedAt: serverTimestamp(), ...(lic.activatedAt ? {} : { activatedAt: serverTimestamp() }) })
    tx.set(licenseStatusRef(lic.id), licenseStatusPatch(lic, { remove: [dev.deviceId] }), { merge: true })
    writeLog(tx, lic.id, 'device_activated', by, `${dev.deviceName || 'Device'} (${dev.deviceId}) activated — ${activationType}`, 'device')
    return { ...lic, activeDevices: lic.activeDevices + 1 }
  })
  const cert = await signFor(license, dev.deviceId, key)
  // Keep the published certificate in step with the one just handed out (a stale one would be re-installed).
  await setDoc(licenseStatusRef(license.id), { certs: { [dev.deviceId]: cert.code }, updatedAt: serverTimestamp() }, { merge: true })
  return { license, cert }
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

export async function approveRequest(req: ActivationRequest, key: LoadedKey, by: string, opts: { clientId?: string; clientLabel?: string } = {}): Promise<'approved' | 'rejected' | 'processed'> {
  const fresh = await getDoc(requestRef(req.id))
  if (!fresh.exists() || fresh.data()?.status !== 'pending') return 'processed'
  if (req.type === 'deactivate') {
    if (req.licenseId) {
      await runTransaction(db, async (tx) => {
        const licSnap = await tx.get(licenseRef(req.licenseId!))
        const devSnap = await tx.get(deviceRef(req.licenseId!, req.deviceId))
        if (licSnap.exists()) deactivateDeviceInTx(tx, licenseFromSnap(licSnap), devSnap, req.deviceId, by, 'by the customer')
      })
    }
    await updateDoc(requestRef(req.id), { status: 'processed', processedAt: serverTimestamp(), processedBy: by })
    return 'processed'
  }
  try {
    const { license, cert } = await issueForDevice(req.licenseKey ?? '', req, key, by, 'online')
    await updateDoc(requestRef(req.id), { status: 'approved', certificate: cert.code, licenseId: license.id, processedAt: serverTimestamp(), processedBy: by })
    if (opts.clientId && !license.clientId) {
      const batch = writeBatch(db)
      batch.update(licenseRef(license.id), { clientId: opts.clientId, updatedAt: serverTimestamp() })
      writeLog(batch, license.id, 'client_linked', by, `License linked to client ${opts.clientLabel ?? opts.clientId} on activation approval`, 'client')
      await batch.commit()
    }
    return 'approved'
  } catch (e) {
    await rejectRequest(req, (e as Error).message, by)
    return 'rejected'
  }
}

export async function rejectRequest(req: ActivationRequest, message: string, by: string): Promise<void> {
  await updateDoc(requestRef(req.id), { status: 'rejected', message: message || 'Rejected by Digital Target', processedAt: serverTimestamp(), processedBy: by })
}

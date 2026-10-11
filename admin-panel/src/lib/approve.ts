/**
 * Activation approval — runs in the admin's browser (no Cloud Functions on the Spark plan).
 * Registers/reactivates the device in a transaction, signs the certificate with the local key,
 * and (for online requests) writes the activation code back to activationRequests/{id}.
 */
import { getDoc, runTransaction, serverTimestamp, updateDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { signPayload, verifyCode, type LicensePayload, type LoadedKey, type SignedCertificate } from './crypto'
import { deactivateDeviceInTx, deviceFromSnap, deviceRef, findLicenseByKey, isExpired, licenseFromSnap, licenseRef, licenseStatusRef, requestRef, statusPatch, writeLog } from './licenses'
import type { ActivationRequest, License } from './types'

export interface DeviceInfo {
  deviceId: string
  deviceName: string
  os: string
  appVersion: string
}

export function buildPayload(l: License, deviceId: string): LicensePayload {
  return {
    v: 1,
    licenseId: l.id,
    customerName: l.customerName || l.businessName,
    businessName: l.businessName || l.customerName,
    phone: l.phone,
    email: l.email,
    deviceId,
    plan: l.plan,
    maxFirms: l.maxFirms,
    maxUsers: l.maxUsers,
    features: l.features,
    issuedAt: new Date().toISOString(),
    expiresAt: l.expiresAt ? l.expiresAt.toDate().toISOString() : null,
    leaseUntil: null,
    graceDays: l.graceDays,
    checkinDays: l.checkinDays
  }
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
    const base = { deviceId: dev.deviceId, deviceName: dev.deviceName, os: dev.os, appVersion: dev.appVersion, lastIssuedAt: serverTimestamp(), activationType }
    if (existing && existing.status === 'active') {
      tx.update(deviceRef(lic.id, dev.deviceId), base)
      writeLog(tx, lic.id, 'certificate_reissued', by, `${dev.deviceName || 'Device'} (${dev.deviceId}) — ${activationType}`)
    } else {
      if (lic.activeDevices >= lic.maxDevices) throw new Error(`Device limit reached (${lic.activeDevices} of ${lic.maxDevices})`)
      tx.set(deviceRef(lic.id, dev.deviceId), { ...base, status: 'active', activatedAt: serverTimestamp(), deactivatedAt: null }, { merge: true })
      tx.update(licenseRef(lic.id), { activeDevices: lic.activeDevices + 1, updatedAt: serverTimestamp() })
      tx.set(licenseStatusRef(lic.id), statusPatch(lic.status, lic.expiresAt, { remove: [dev.deviceId] }), { merge: true })
      writeLog(tx, lic.id, 'device_activated', by, `${dev.deviceName || 'Device'} (${dev.deviceId}) activated — ${activationType}`)
    }
    return lic
  })
  const cert = await signPayload(buildPayload(license, dev.deviceId), key.seed)
  if (!(await verifyCode(cert.code, key.publicKey))) throw new Error('Signature self-check failed. Reload the signing key.')
  return { license, cert }
}

export async function approveRequest(req: ActivationRequest, key: LoadedKey, by: string): Promise<'approved' | 'rejected' | 'processed'> {
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
    return 'approved'
  } catch (e) {
    await rejectRequest(req, (e as Error).message, by)
    return 'rejected'
  }
}

export async function rejectRequest(req: ActivationRequest, message: string, by: string): Promise<void> {
  await updateDoc(requestRef(req.id), { status: 'rejected', message: message || 'Rejected by Digital Target', processedAt: serverTimestamp(), processedBy: by })
}

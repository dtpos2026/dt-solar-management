/**
 * Instant activation on the Spark plan (no server code).
 *
 * For every active license the portal publishes an "activation pass": a certificate signed with the owner's key for
 * device '*', stored at activationPasses/{sha256(licenseKey)} (public get by id, never listable). The desktop fetches
 * it with the key the customer typed, verifies the signature, and registers ITS computer on the license in one
 * Firestore commit. The rules accept that commit only while the license is active and not expired, a device slot is
 * free (activeDevices + 1 <= maxDevices) and the computer was never registered on the license before. So a valid key
 * activates a new computer immediately; approval is only needed where it is genuinely required: the device limit is
 * full (replace a computer) or the computer was released / deactivated earlier.
 *
 * Passes are (re)signed automatically whenever an admin with license rights has the signing key loaded
 * (<PassSync/> in the app shell): new licenses, renewals and term changes get a fresh pass; suspended / revoked
 * licenses lose theirs. The private key never leaves the browser.
 */
import { doc, getDocs, serverTimestamp, writeBatch } from 'firebase/firestore'
import { db } from '../firebase'
import { certTermsOf } from './approve'
import { sha256Hex, signPayload, verifyCode, type LoadedKey } from './crypto'
import { backfillSummary, devicesCol, licenseRef, writeLog } from './licenses'
import { buildCertPayload } from './terms'
import type { License } from './types'

/** Device id of an activation pass (the desktop binds it to its own computer after registering). */
export const PASS_DEVICE = '*'

const enc = (s: string): Uint8Array => new TextEncoder().encode(s)

/** Document id of a license's activation pass: lowercase hex SHA-256 of the upper-case license key. */
export function licenseKeyHash(licenseKey: string): Promise<string> {
  return sha256Hex(enc(licenseKey.trim().toUpperCase()))
}

export const passRef = (hash: string) => doc(db, 'activationPasses', hash)

/** A pass exists only for licenses that may activate new computers. */
export function passWanted(l: Pick<License, 'status'>): boolean {
  return l.status === 'active'
}

/** Fingerprint of the terms a pass was signed for (+ the signing key): a different value means "re-sign". */
export async function passTermsHash(l: License, key: Pick<LoadedKey, 'fingerprint'>): Promise<string> {
  return (await sha256Hex(enc(`${JSON.stringify(certTermsOf(l))}|${key.fingerprint}`))).slice(0, 32)
}

export async function publishPass(l: License, key: LoadedKey, by: string): Promise<void> {
  const cert = await signPayload(buildCertPayload(certTermsOf(l), PASS_DEVICE), key.seed)
  if (!(await verifyCode(cert.code, key.publicKey))) throw new Error('Signature self-check failed. Reload the signing key.')
  const [hash, termsHash] = await Promise.all([licenseKeyHash(l.licenseKey), passTermsHash(l, key)])
  const batch = writeBatch(db)
  batch.set(passRef(hash), { licenseId: l.id, cert: cert.code, updatedAt: serverTimestamp() })
  batch.update(licenseRef(l.id), { passHash: termsHash })
  if (!l.passHash) writeLog(batch, l.id, 'instant_activation_enabled', by, 'Activation pass published: new computers activate immediately within the device limit', 'license')
  await batch.commit()
}

export async function removePass(l: License, by: string): Promise<void> {
  const batch = writeBatch(db)
  batch.delete(passRef(await licenseKeyHash(l.licenseKey)))
  batch.update(licenseRef(l.id), { passHash: '' })
  writeLog(batch, l.id, 'instant_activation_disabled', by, `Activation pass withdrawn (license ${l.status})`, 'license')
  await batch.commit()
}

let running: Promise<void> | null = null
let again: (() => Promise<void>) | null = null

/**
 * Brings every license's pass in line with its terms. Serialised: a call made while one runs is queued once with
 * the latest arguments. Errors on one license do not stop the others; the last error is returned.
 */
export function syncPasses(licenses: License[], key: LoadedKey, by: string): Promise<void> {
  const job = async (): Promise<void> => {
    for (const l of licenses) {
      if (!l.licenseKey) continue
      try {
        if (passWanted(l)) {
          // Instant registration needs the device summary on the license (older licenses may lack it).
          if (l.devicesSummary === null) await backfillSummary(l.id, (await getDocs(devicesCol(l.id))).docs, l.updatedAt?.toMillis() ?? null)
          if (l.passHash !== (await passTermsHash(l, key))) await publishPass(l, key, by)
        } else if (l.passHash) {
          await removePass(l, by)
        }
      } catch (e) {
        console.warn('Activation pass sync failed for license', l.id, e)
      }
    }
  }
  if (running) {
    again = job
    return running
  }
  running = (async () => {
    try {
      await job()
      while (again) {
        const next = again
        again = null
        await next()
      }
    } finally {
      running = null
    }
  })()
  return running
}

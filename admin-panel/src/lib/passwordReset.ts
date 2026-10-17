/**
 * Administrator password reset for a client's DT Solar Pro (Super Admin action).
 *
 * Nothing secret is stored or sent in plain text: the browser creates a random temporary password, signs a command that holds
 * only a salted PBKDF2-SHA256 verifier of it (plus the computer's device id, a nonce and an expiry) and shows the temporary
 * password ONCE to the Super Admin, who relays it to the customer. The command is published to licenseStatus.commands[deviceId]
 * (online computers pick it up at their next check-in, within minutes) and can be pasted on the customer's sign-in screen
 * (offline computers). The desktop app verifies the signature, the device, the expiry and the one-time nonce, and only the
 * person who knows the temporary password can use it; the app then forces a new password. Format: src/main/services/adminReset.ts.
 */
import { deleteField, serverTimestamp, writeBatch } from 'firebase/firestore'
import { db } from '../firebase'
import type { LoadedKey } from './crypto'
import { buildResetCommand, type ResetCommand } from './resetCommand'
import { deviceLabel, licenseStatusRef, writeLog } from './licenses'
import type { License } from './types'

/** Creates the command and publishes it for the computer (licenseStatus.commands) in one write with its security log entry. */
export async function issueAdminPasswordReset(license: License, device: { deviceId: string; deviceName: string }, key: LoadedKey, by: string): Promise<ResetCommand> {
  const cmd = await buildResetCommand({ licenseId: license.id, deviceId: device.deviceId, key })
  const batch = writeBatch(db)
  batch.set(licenseStatusRef(license.id), { commands: { [device.deviceId]: cmd.code }, updatedAt: serverTimestamp() }, { merge: true })
  writeLog(
    batch,
    license.id,
    'admin_password_reset_issued',
    by,
    `Administrator password reset issued for ${deviceLabel(device.deviceName, device.deviceId)}; valid until ${cmd.expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC, one use (code ${cmd.nonce.slice(0, 6)}…)`,
    'security'
  )
  await batch.commit()
  return cmd
}

/** Withdraws a published reset (the customer's app ignores it from the next check-in). */
export async function cancelAdminPasswordReset(license: License, device: { deviceId: string; deviceName: string }, by: string): Promise<void> {
  const batch = writeBatch(db)
  batch.set(licenseStatusRef(license.id), { commands: { [device.deviceId]: deleteField() }, updatedAt: serverTimestamp() }, { merge: true })
  writeLog(batch, license.id, 'admin_password_reset_cancelled', by, `Administrator password reset withdrawn for ${deviceLabel(device.deviceName, device.deviceId)}`, 'security')
  await batch.commit()
}


export { RESET_VALID_HOURS, generateTempPassword, resetProgress, type ResetCommand } from './resetCommand'

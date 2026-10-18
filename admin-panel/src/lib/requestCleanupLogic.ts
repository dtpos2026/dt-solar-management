/** Pure part of lib/requestCleanup.ts (no Firebase imports, unit tested). */
import { keyMismatch } from './keyId'
import { normaliseLicenseKey } from './crypto'
import type { ActivationRequest, License } from './types'

/**
 * Pending activation requests that need nothing more: the computer already holds an active slot on the license. A request from an
 * installer built with a different signing key is never included: that computer cannot verify anything signed here.
 */
export function satisfiedRequests(pending: ActivationRequest[], licenses: License[], loadedFingerprint?: string): Array<{ request: ActivationRequest; license: License }> {
  const byKey = new Map(licenses.map((l) => [l.licenseKey, l]))
  const out: Array<{ request: ActivationRequest; license: License }> = []
  for (const r of pending) {
    if (r.type !== 'activate' || r.status !== 'pending') continue
    if (keyMismatch(r.keyId, loadedFingerprint)) continue
    const l = byKey.get(normaliseLicenseKey(r.licenseKey ?? ''))
    if (l?.devicesSummary?.[r.deviceId]?.status !== 'active') continue
    out.push({ request: r, license: l })
  }
  return out
}

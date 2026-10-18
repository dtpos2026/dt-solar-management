/**
 * Key ID: the first 16 hex digits of the signing key fingerprint. The desktop app computes the same value from the public key
 * built into its installer and sends it with every activation request, so a mismatch between the installer and the signing
 * key loaded here (the cause of "License signature is invalid" and activations that never complete) is visible at once.
 */
export const keyIdOf = (fingerprint: string): string => fingerprint.replace(/[^0-9A-Fa-f]/g, '').slice(0, 16).toUpperCase()

/** True only when both sides are known and differ. A request from an older build (no key ID) is never blocked by this check. */
export function keyMismatch(requestKeyId: string | undefined, loadedFingerprint: string | undefined): boolean {
  if (!requestKeyId || !loadedFingerprint) return false
  // A build made on a computer with several earlier signing keys trusts all of them: "ID1,ID2,...".
  return !requestKeyId.toUpperCase().split(',').map((x) => x.trim()).includes(keyIdOf(loadedFingerprint))
}

export const keyMismatchText = (requestKeyId: string, loadedFingerprint: string): string =>
  `This installer was built with license key ${requestKeyId.toUpperCase()}, but the signing key loaded here is ${keyIdOf(loadedFingerprint)}. Anything signed here can never be verified by that installer. Load the private key that matches the installer, or rebuild the installer from the folder that holds this key.`

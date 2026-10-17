/** Shared license types (desktop app). The same payload format is produced by the Firebase functions and scripts/license-tool.mjs. */
export interface LicensePayload {
  v: 1
  licenseId: string
  customerName: string
  businessName: string
  phone?: string
  email?: string
  deviceId: string
  plan: string
  maxFirms: number
  maxUsers: number
  features: string[]
  issuedAt: string
  /** License end date (ISO). null = lifetime. */
  expiresAt: string | null
  /** The app must check in online before this date (ISO). null = fully offline license. */
  leaseUntil: string | null
  /** Days the app keeps working after the lease ends without a successful check-in. */
  graceDays: number
  /**
   * Online verification interval in days (0/undefined = never required). The app checks the license status in
   * Firestore whenever internet is available; if no successful check has happened for this many days, the grace
   * period starts. Lets suspension/revocation reach disconnected computers eventually without a signing server.
   */
  checkinDays?: number
  /** v1.1 (optional, older certificates omit them) */
  /** Billing cycle of the plan: monthly | yearly | lifetime. */
  planType?: string
  /** Super Admin client record this license belongs to. */
  clientId?: string
  maxDevices?: number
  /** Show "Powered by Digital Target" on customer documents (default false - customer documents are white-label). */
  poweredBy?: boolean
  /**
   * Lifetime license detached from central management: no online check-ins are required or performed, so the
   * installation can no longer be suspended remotely. Can only be set on lifetime (expiresAt null) licenses.
   */
  detached?: boolean
}

export interface LicenseCertificate {
  format: 'dtsp-license'
  version: 1
  payload: string
  signature: string
}

/**
 * - not_activated: no certificate installed (fresh install, or an old installation that used the former local trial).
 *   Read-only: data can be viewed, printed, exported and backed up; nothing can be created until a license is installed.
 * - trial: a Super Admin-issued trial license (plan 'trial', short expiry) - there is no local trial any more.
 * - trial_expired: that trial license has passed its expiry date.
 * - device_deactivated: Digital Target suspended / released THIS computer on the license (the license itself may be fine).
 */
export type LicenseMode =
  | 'not_activated'
  | 'trial'
  | 'active'
  | 'grace'
  | 'trial_expired'
  | 'expired'
  | 'suspended'
  | 'revoked'
  | 'device_deactivated'
  | 'lease_expired'
  | 'clock_error'
  | 'invalid'

/** Remote decision published by Digital Target (licenseStatus) that blocks this installation. */
export type RemoteBlock = 'suspended' | 'revoked' | 'deactivated'

/** Remote decision as persisted in BOTH the license folder state and the business DB (settings.license_remote). */
export interface RemoteRecord {
  licenseId: string
  status: RemoteBlock
  /** When this computer learned about the decision (ISO). Only a certificate issued after it can lift it offline. */
  at: string
}

/** Why writes are blocked: the license, this device, connectivity (overdue check-in), missing activation, or the clock. */
export type BlockReason = 'license' | 'device' | 'connectivity' | 'activation' | 'clock'

export interface LicenseStatus {
  mode: LicenseMode
  /** null when writes are allowed. */
  blockReason: BlockReason | null
  /** An old installation that used the former local 15-day trial (data kept, read-only until activated). */
  legacyTrial: boolean
  canWrite: boolean
  message: string
  deviceId: string
  deviceName: string
  payload: LicensePayload | null
  trialDaysLeft: number | null
  daysLeft: number | null
  graceDaysLeft: number | null
  lastCheckAt: string | null
  lastCheckError: string | null
  pendingRequestId: string | null
  /** Why the pending activation needs Digital Target's approval (instant activation was not possible). */
  pendingReason?: string | null
  onlineConfigured: boolean
  signingConfigured: boolean
  maxFirms: number
  maxUsers: number
  /** v1.1 */
  poweredBy: boolean
  detached: boolean
  /** Customer registration details sent with the last online activation (company, owner, phone, address). */
  registration: Registration | null
  /** Installation id (secret token) shortened for display - never the full value. */
  installId: string
  /** Last certificate that reached this computer through a check-in (renewal / plan / limits / detachment). */
  certUpdate: { at: string; summary: string } | null
  /** Outcome of the last online activation request (shown until the next request). */
  activationNotice: ActivationNotice | null
}

export interface Registration {
  companyName: string
  ownerName: string
  phone: string
  address: string
}

export interface ActivationNotice {
  kind: 'approved' | 'rejected'
  message: string
  at: string
  licenseKey?: string
}

export interface ActivationResult {
  pending: boolean
  /** 'pending' while Digital Target has not answered, 'approved' when the license was installed, 'none' when nothing is pending. */
  state: 'pending' | 'approved' | 'rejected' | 'none'
  requestId: string | null
  message: string
  status: LicenseStatus
}

/** Default length of a Super Admin-issued trial license (the portal sets the real expiry in the certificate). */
export const TRIAL_DAYS = 15
/** Display-only limits while no certificate is installed (writes are blocked anyway). */
export const TRIAL_LIMITS = { maxFirms: 5, maxUsers: 5 }

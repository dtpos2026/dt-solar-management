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
}

export interface LicenseCertificate {
  format: 'dtsp-license'
  version: 1
  payload: string
  signature: string
}

export type LicenseMode =
  | 'trial'
  | 'active'
  | 'grace'
  | 'trial_expired'
  | 'expired'
  | 'suspended'
  | 'revoked'
  | 'lease_expired'
  | 'clock_error'
  | 'invalid'

export interface LicenseStatus {
  mode: LicenseMode
  canWrite: boolean
  message: string
  deviceId: string
  deviceName: string
  payload: LicensePayload | null
  trialDaysLeft: number | null
  daysLeft: number | null
  graceDaysLeft: number | null
  lastCheckAt: string | null
  onlineConfigured: boolean
  signingConfigured: boolean
  maxFirms: number
  maxUsers: number
}

export const TRIAL_DAYS = 15
export const TRIAL_LIMITS = { maxFirms: 5, maxUsers: 5 }

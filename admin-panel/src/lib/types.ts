import type { Timestamp } from 'firebase/firestore'

export type Plan = 'standard' | 'professional' | 'enterprise' | 'trial'
export type LicenseState = 'active' | 'suspended' | 'revoked'

export const FEATURES: { id: string; label: string; hint: string }[] = [
  { id: 'multi_firm', label: 'Multiple firms', hint: 'Run more than one business/firm in the same installation.' },
  { id: 'projects', label: 'Solar projects', hint: 'Project costing and profitability.' },
  { id: 'advanced_reports', label: 'Advanced reports', hint: 'Extended financial and stock reports.' }
]

export const PLAN_PRESETS: Record<Plan, { label: string; maxDevices: number; maxFirms: number; maxUsers: number; features: string[] }> = {
  standard: { label: 'Standard', maxDevices: 1, maxFirms: 2, maxUsers: 3, features: ['projects'] },
  professional: { label: 'Professional', maxDevices: 2, maxFirms: 5, maxUsers: 10, features: ['multi_firm', 'projects'] },
  enterprise: { label: 'Enterprise', maxDevices: 5, maxFirms: 10, maxUsers: 50, features: ['multi_firm', 'projects', 'advanced_reports'] },
  trial: { label: 'Trial', maxDevices: 1, maxFirms: 1, maxUsers: 3, features: ['projects'] }
}

/** Plans an admin can choose when creating / changing a paid license (a trial is issued with "Issue trial"). */
export const PAID_PLANS: Exclude<Plan, 'trial'>[] = ['standard', 'professional', 'enterprise']

export const DEFAULT_CHECKIN_DAYS = 30
export const DEFAULT_GRACE_DAYS = 15

export interface License {
  id: string
  /** v1.1 */
  clientId: string
  planType: PlanType
  poweredBy: boolean
  detached: boolean
  detachedAt: Timestamp | null
  detachedBy: string
  paymentStatus: 'paid' | 'partial' | 'unpaid' | 'none'
  activatedAt: Timestamp | null
  lastVerifiedAt: Timestamp | null
  licenseKey: string
  customerName: string
  businessName: string
  phone: string
  email: string
  city: string
  plan: Plan
  status: LicenseState
  maxDevices: number
  maxFirms: number
  maxUsers: number
  features: string[]
  expiresAt: Timestamp | null
  checkinDays: number
  graceDays: number
  notes: string
  activeDevices: number
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
  /**
   * Denormalised copy of the devices sub-collection (deviceId → summary), written in the same transaction as
   * every device change so the Devices page needs no read per license. null on licenses never touched since.
   */
  devicesSummary: Record<string, DeviceSummary> | null
  /** Terms fingerprint of the published activation pass ('' = none yet). See lib/activationPass.ts. */
  passHash: string
}

export interface DeviceSummary {
  deviceName: string
  os: string
  appVersion: string
  status: 'active' | 'suspended' | 'revoked' | 'deactivated'
  activatedAtMs: number | null
  activationType: 'online' | 'offline' | 'instant'
  statusNote: string
}

export interface Device {
  id: string
  deviceId: string
  deviceName: string
  os: string
  appVersion: string
  /** active | suspended | revoked hold a slot of maxDevices; deactivated (released) frees it. */
  status: 'active' | 'suspended' | 'revoked' | 'deactivated'
  activatedAt: Timestamp | null
  activationType: 'online' | 'offline' | 'instant'
  lastIssuedAt: Timestamp | null
  deactivatedAt?: Timestamp | null
  /** v1.1: reason / note of the last suspend / revoke / release, when and by whom. */
  statusNote?: string
  statusChangedAt?: Timestamp | null
  statusBy?: string
}

export interface HistoryEntry {
  id: string
  action: string
  by: string
  at: Timestamp | null
  details: string
}

export interface AuditEntry {
  id: string
  action: string
  by: string
  at: Timestamp | null
  licenseId: string | null
  details: string
  /** v1.1 */
  category: AuditCategory
  byUid: string
  target: string
  targetType: string
  status: 'success' | 'failure'
  archived: boolean
}

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'processed'

export interface ActivationRequest {
  id: string
  type: 'activate' | 'deactivate'
  licenseKey?: string
  licenseId?: string
  deviceId: string
  deviceName: string
  appVersion: string
  os: string
  status: RequestStatus
  createdAt: Timestamp | null
  processedAt?: Timestamp | null
  processedBy?: string
  message?: string
  certificate?: string
  /** v1.1 registration details sent by the desktop wizard */
  companyName?: string
  ownerName?: string
  phone?: string
  address?: string
  installToken?: string
  /** Key ID of the license public key built into the installer (see lib/keyId.ts) */
  keyId?: string
}

export interface AdminDoc {
  email: string
  name: string
  /** 'owner' (legacy 'superadmin') or a preset / custom role - see lib/perm.ts */
  role: string
  permissions?: string[]
  active?: boolean
  createdAt?: Timestamp | null
  createdBy?: string
}

/* ------------------------------------------------ v1.1 ------------------------------------------------ */

export type PlanType = 'monthly' | 'yearly' | 'lifetime' | 'trial'

export interface Client {
  id: string
  code: string
  company: string
  ownerName: string
  phone: string
  email: string
  address: string
  city: string
  logo: string | null
  status: 'active' | 'suspended' | 'archived'
  plan: string
  planType: PlanType
  allowedFirms: number
  allowedDevices: number
  notes: string
  registeredAt: Timestamp | null
  createdAt: Timestamp | null
  updatedAt: Timestamp | null
  createdBy: string
}

export interface HeartbeatLocation {
  lat: number
  lng: number
  accuracyKm?: number
  /** device = Windows location service (accuracy in metres), approximate = internet IP (city level at best), manual = typed. */
  source: 'device' | 'approximate' | 'manual'
  label?: string
  consent: true
  updatedAt?: string
}

export interface Heartbeat {
  /** Document id = installation secret token. Never display it in full. */
  id: string
  deviceId: string
  licenseId: string
  deviceName: string
  os: string
  appVersion: string
  companyName: string
  mode: string
  lastCheckAt: string
  firms: number
  /** Active firms (the license limit counts these); older apps do not report it. */
  firmsActive: number | null
  users: number
  /** Why this computer sent no location (set by the desktop app). */
  locationNote: string
  /** sharing | not_asked | declined | os_denied | service_off | unavailable | waiting ('' = older app version). */
  locationStatus: string
  /** Administrator password reset progress reported by the computer: "<nonce>:received" | "<nonce>:used". */
  resetState: string
  lastSeen: Timestamp | null
  location: HeartbeatLocation | null
}

export type InvoiceLineKind = 'plan' | 'extra_firm' | 'extra_device' | 'other'

export interface InvoiceLine {
  kind: InvoiceLineKind
  description: string
  qty: number
  rate: number
  amount: number
}

export type InvoiceStatus = 'unpaid' | 'partial' | 'paid' | 'cancelled'

export interface Invoice {
  id: string
  number: string
  clientId: string
  clientName: string
  licenseId: string
  planType: PlanType | ''
  issueDate: Timestamp | null
  dueDate: Timestamp | null
  currency: string
  lines: InvoiceLine[]
  subtotal: number
  discount: number
  taxRate: number
  taxAmount: number
  total: number
  paid: number
  balance: number
  status: InvoiceStatus
  verifyToken: string
  notes: string
  createdAt: Timestamp | null
  createdBy: string
  updatedAt: Timestamp | null
  cancelledAt: Timestamp | null
  cancelReason: string
  lastPaymentAt: Timestamp | null
}

export interface InvoicePayment {
  id: string
  amount: number
  method: string
  reference: string
  date: Timestamp | null
  receiptNo: string
  createdAt: Timestamp | null
  createdBy: string
  cancelled?: boolean
  cancelReason?: string
}

export interface SupportThread {
  /** Document id = installation secret token. */
  id: string
  deviceId: string
  licenseId: string
  companyName: string
  contactName: string
  phone: string
  status: 'open' | 'pending' | 'resolved'
  lastMessageAt: Timestamp | null
  lastMessageFrom: 'customer' | 'admin'
  lastMessagePreview: string
  unreadByAdmin: boolean
  unreadByCustomer: boolean
  createdAt: Timestamp | null
}

export interface SupportMessage {
  id: string
  from: 'customer' | 'admin'
  body: string
  authorName: string
  at: Timestamp | null
}

export interface Branding {
  companyName: string
  logo: string | null
  signature: string | null
  signatoryName: string
  paymentQr: string | null
  phone: string
  email: string
  address: string
  website: string
  bankName: string
  bankTitle: string
  bankAccount: string
  iban: string
  currency: string
  invoicePrefix: string
  receiptPrefix: string
  taxName: string
  taxRate: number
  invoiceFooter: string
  terms: string
  supportPhone: string
  supportWhatsapp: string
  supportEmail: string
  poweredByDefault: boolean
  customerPrivacy: 'full' | 'masked' | 'hidden'
  verifyBaseUrl: string
  mapTileUrl: string
  mapAttribution: string
}

export const DEFAULT_BRANDING: Branding = {
  companyName: 'Digital Target',
  logo: null,
  signature: null,
  signatoryName: 'Digital Target',
  paymentQr: null,
  phone: '+92 345 1873354',
  email: 'digitaltarget.digital@gmail.com',
  address: 'Multan, Pakistan',
  website: '',
  bankName: '',
  bankTitle: '',
  bankAccount: '',
  iban: '',
  currency: 'PKR',
  invoicePrefix: 'DT-INV-',
  receiptPrefix: 'DT-RCP-',
  taxName: 'Tax',
  taxRate: 0,
  invoiceFooter: 'Thank you for your business!',
  terms: 'Payment is due on receipt of this invoice.\nLicense fees are non-refundable once the license is activated.\nThis invoice can be verified by scanning its QR code.',
  supportPhone: '+92 345 1873354',
  supportWhatsapp: '923451873354',
  supportEmail: 'digitaltarget.digital@gmail.com',
  poweredByDefault: false,
  customerPrivacy: 'masked',
  verifyBaseUrl: '',
  mapTileUrl: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  mapAttribution: '&copy; OpenStreetMap contributors'
}

export type AuditCategory = 'security' | 'financial' | 'license' | 'client' | 'device' | 'support' | 'settings' | 'general'

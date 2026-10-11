import type { Timestamp } from 'firebase/firestore'

export type Plan = 'standard' | 'professional' | 'enterprise'
export type LicenseState = 'active' | 'suspended' | 'revoked'

export const FEATURES: { id: string; label: string; hint: string }[] = [
  { id: 'multi_firm', label: 'Multiple firms', hint: 'Run more than one business/firm in the same installation.' },
  { id: 'projects', label: 'Solar projects', hint: 'Project costing and profitability.' },
  { id: 'advanced_reports', label: 'Advanced reports', hint: 'Extended financial and stock reports.' }
]

export const PLAN_PRESETS: Record<Plan, { label: string; maxDevices: number; maxFirms: number; maxUsers: number; features: string[] }> = {
  standard: { label: 'Standard', maxDevices: 1, maxFirms: 2, maxUsers: 3, features: ['projects'] },
  professional: { label: 'Professional', maxDevices: 2, maxFirms: 5, maxUsers: 10, features: ['multi_firm', 'projects'] },
  enterprise: { label: 'Enterprise', maxDevices: 5, maxFirms: 10, maxUsers: 50, features: ['multi_firm', 'projects', 'advanced_reports'] }
}

export const DEFAULT_CHECKIN_DAYS = 30
export const DEFAULT_GRACE_DAYS = 15

export interface License {
  id: string
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
}

export interface Device {
  id: string
  deviceId: string
  deviceName: string
  os: string
  appVersion: string
  status: 'active' | 'deactivated'
  activatedAt: Timestamp | null
  activationType: 'online' | 'offline'
  lastIssuedAt: Timestamp | null
  deactivatedAt?: Timestamp | null
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
}

export interface AdminDoc {
  email: string
  name: string
  role: 'superadmin'
}

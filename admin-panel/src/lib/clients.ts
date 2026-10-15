/**
 * Pure client (company) helpers: code formatting, validation, prefills and delete guard.
 * No Firebase imports (unit tested from tests/portal-licensing.test.ts). Firestore access lives in clientsDb.ts.
 */
import type { PlanType } from './types'

export type ClientStatus = 'active' | 'suspended' | 'archived'
export const CLIENT_STATUSES: ClientStatus[] = ['active', 'suspended', 'archived']
export const PLAN_TYPES: PlanType[] = ['monthly', 'yearly', 'lifetime']
export const PLAN_TYPE_LABEL: Record<PlanType, string> = { monthly: 'Monthly', yearly: 'Yearly', lifetime: 'Lifetime' }

/** Logo is stored inline as a data URL (no Storage on the Spark plan). */
export const LOGO_MAX_BYTES = 200 * 1024

/** Client code from the counters/clients sequence: 1 → "DTC-0001", 12345 → "DTC-12345". */
export function formatClientCode(n: number): string {
  const v = Math.max(1, Math.floor(Number.isFinite(n) ? n : 1))
  return `DTC-${String(v).padStart(4, '0')}`
}

export interface ClientInput {
  company: string
  ownerName: string
  phone: string
  email: string
  address: string
  city: string
  logo: string | null
  status: ClientStatus
  plan: string
  planType: PlanType
  allowedFirms: number
  allowedDevices: number
  notes: string
  /** yyyy-mm-dd or '' */
  registeredAt: string
}

export function blankClient(): ClientInput {
  return {
    company: '',
    ownerName: '',
    phone: '',
    email: '',
    address: '',
    city: '',
    logo: null,
    status: 'active',
    plan: 'professional',
    planType: 'yearly',
    allowedFirms: 5,
    allowedDevices: 2,
    notes: '',
    registeredAt: ''
  }
}

/** Approximate decoded size of a data URL in bytes. */
export function dataUrlBytes(dataUrl: string | null | undefined): number {
  if (!dataUrl) return 0
  const i = dataUrl.indexOf(',')
  const b64 = i >= 0 ? dataUrl.slice(i + 1) : dataUrl
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad)
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE_RE = /^[+()\-\s0-9]{5,30}$/

/** Field → message. Empty object = valid. */
export function validateClient(c: ClientInput): Partial<Record<keyof ClientInput, string>> {
  const e: Partial<Record<keyof ClientInput, string>> = {}
  const company = c.company.trim()
  if (!company) e.company = 'Company name is required.'
  else if (company.length > 200) e.company = 'Company name is too long (max 200 characters).'
  if (c.ownerName.trim().length > 200) e.ownerName = 'Owner name is too long.'
  if (c.phone.trim() && !PHONE_RE.test(c.phone.trim())) e.phone = 'Enter a valid phone number (digits, spaces, + - ( )).'
  if (c.email.trim() && !EMAIL_RE.test(c.email.trim())) e.email = 'Enter a valid email address.'
  if (c.address.length > 300) e.address = 'Address is too long (max 300 characters).'
  if (!CLIENT_STATUSES.includes(c.status)) e.status = 'Choose a status.'
  if (!PLAN_TYPES.includes(c.planType)) e.planType = 'Choose a billing cycle.'
  if (!Number.isInteger(c.allowedFirms) || c.allowedFirms < 1 || c.allowedFirms > 1000) e.allowedFirms = 'Allowed firms must be a whole number from 1 to 1000.'
  if (!Number.isInteger(c.allowedDevices) || c.allowedDevices < 1 || c.allowedDevices > 1000) e.allowedDevices = 'Allowed computers must be a whole number from 1 to 1000.'
  if (c.logo && !/^data:image\/(png|jpeg|webp);base64,/.test(c.logo)) e.logo = 'Logo must be a PNG, JPEG or WebP image.'
  else if (dataUrlBytes(c.logo) > LOGO_MAX_BYTES) e.logo = 'Logo is larger than 200 KB even after compression. Use a smaller image.'
  if (c.notes.length > 4000) e.notes = 'Notes are too long (max 4000 characters).'
  if (c.registeredAt && !/^\d{4}-\d{2}-\d{2}$/.test(c.registeredAt)) e.registeredAt = 'Enter a valid date.'
  return e
}

export function clientSearchText(c: { code?: string; company?: string; ownerName?: string; phone?: string; email?: string; city?: string }): string {
  return [c.code, c.company, c.ownerName, c.phone, c.email, c.city].filter(Boolean).join(' ').toLowerCase()
}

/** Hard delete is owner-only and only when no license or invoice references the client. */
export function hardDeleteGuard(x: { isOwner: boolean; linkedLicenses: number; linkedInvoices: number; linkedThreads?: number }): { ok: boolean; reason: string } {
  if (!x.isOwner) return { ok: false, reason: 'Only the owner can permanently delete a client. Archive it instead.' }
  const parts: string[] = []
  if (x.linkedLicenses) parts.push(`${x.linkedLicenses} license(s)`)
  if (x.linkedInvoices) parts.push(`${x.linkedInvoices} invoice(s)`)
  if (x.linkedThreads) parts.push(`${x.linkedThreads} support conversation(s)`)
  if (parts.length) return { ok: false, reason: `This client is linked to ${parts.join(', ')}. Archive it instead — linked records are never deleted.` }
  return { ok: true, reason: '' }
}

/** Prefill a client from a legacy license (licenses created before clients existed). */
export function clientFromLicense(l: {
  businessName: string
  customerName: string
  phone: string
  email: string
  city: string
  plan: string
  planType: PlanType
  maxFirms: number
  maxDevices: number
}): ClientInput {
  return {
    ...blankClient(),
    company: (l.businessName || l.customerName).trim(),
    ownerName: l.customerName.trim(),
    phone: l.phone.trim(),
    email: l.email.trim(),
    city: l.city.trim(),
    plan: l.plan,
    planType: l.planType,
    allowedFirms: Math.max(1, l.maxFirms || 1),
    allowedDevices: Math.max(1, l.maxDevices || 1)
  }
}

/** Prefill a client from the registration details of a desktop activation request. */
export function clientFromRegistration(r: { companyName?: string; ownerName?: string; phone?: string; address?: string }): ClientInput {
  return {
    ...blankClient(),
    company: (r.companyName ?? '').trim().slice(0, 200),
    ownerName: (r.ownerName ?? '').trim().slice(0, 200),
    phone: (r.phone ?? '').trim().slice(0, 60),
    address: (r.address ?? '').trim().slice(0, 300)
  }
}

/** Best client match for registration details (same phone, or same company name ignoring case). */
export function matchClient<T extends { id: string; company: string; phone: string; status: string }>(clients: T[], r: { companyName?: string; phone?: string }): T | null {
  const digits = (s: string) => s.replace(/\D/g, '')
  const phone = digits(r.phone ?? '')
  const name = (r.companyName ?? '').trim().toLowerCase()
  const live = clients.filter((c) => c.status !== 'archived')
  if (phone.length >= 7) {
    const byPhone = live.find((c) => digits(c.phone).endsWith(phone.slice(-10)) && digits(c.phone).length >= 7)
    if (byPhone) return byPhone
  }
  if (name) return live.find((c) => c.company.trim().toLowerCase() === name) ?? null
  return null
}

/**
 * Digital Target branding / portal settings helpers (pure - no Firebase imports; unit tested).
 * Firestore access: lib/brandingStore.ts. Browser image compression: lib/imageFile.ts.
 */
import { DEFAULT_BRANDING, type Branding } from './types'

/** Every image (logo, signature, payment QR) is stored inline as a data URL and kept under this size. */
export const MAX_IMAGE_BYTES = 150 * 1024
export const IMAGE_FIELDS = ['logo', 'signature', 'paymentQr'] as const
export type ImageField = (typeof IMAGE_FIELDS)[number]

/** Fields copied to publicSettings/branding (public get - shown on the invoice verification page). */
export const PUBLIC_BRANDING_FIELDS = ['companyName', 'logo', 'phone', 'email', 'website', 'address'] as const
export type PublicBranding = Pick<Branding, (typeof PUBLIC_BRANDING_FIELDS)[number]>

export const DEFAULT_SESSION_TIMEOUT_MIN = 30
export const MIN_SESSION_TIMEOUT_MIN = 5
export const MAX_SESSION_TIMEOUT_MIN = 480

const str = (v: unknown, d: string): string => (typeof v === 'string' ? v : d)

/** Fills missing / mistyped fields from DEFAULT_BRANDING. */
export function normaliseBranding(data: Record<string, unknown> | null | undefined): Branding {
  const d = data ?? {}
  const out = { ...DEFAULT_BRANDING }
  for (const k of Object.keys(DEFAULT_BRANDING) as (keyof Branding)[]) {
    const def = DEFAULT_BRANDING[k]
    const v = d[k]
    if (IMAGE_FIELDS.includes(k as ImageField)) {
      ;(out as Record<string, unknown>)[k] = typeof v === 'string' && v.startsWith('data:image/') ? v : null
    } else if (typeof def === 'number') {
      ;(out as Record<string, unknown>)[k] = typeof v === 'number' && Number.isFinite(v) ? v : def
    } else if (typeof def === 'boolean') {
      ;(out as Record<string, unknown>)[k] = typeof v === 'boolean' ? v : def
    } else {
      ;(out as Record<string, unknown>)[k] = str(v, def as string)
    }
  }
  if (!['full', 'masked', 'hidden'].includes(out.customerPrivacy)) out.customerPrivacy = DEFAULT_BRANDING.customerPrivacy
  return out
}

export function publicBranding(b: Branding): PublicBranding {
  return { companyName: b.companyName, logo: b.logo, phone: b.phone, email: b.email, website: b.website, address: b.address }
}

/** Trims text fields and rounds the tax rate (2 decimals) before saving. */
export function cleanBranding(b: Branding): Branding {
  const out = { ...b }
  for (const k of Object.keys(out) as (keyof Branding)[]) {
    const v = out[k]
    if (typeof v === 'string' && !IMAGE_FIELDS.includes(k as ImageField)) (out as Record<string, unknown>)[k] = v.trim()
  }
  out.taxRate = Math.round((Number.isFinite(out.taxRate) ? out.taxRate : 0) * 100) / 100
  out.currency = out.currency.toUpperCase()
  out.verifyBaseUrl = out.verifyBaseUrl.replace(/\/+$/, '')
  return out
}

/** Decoded size in bytes of a base64 data URL (what Firestore stores is the string - see dataUrlStoredBytes). */
export function dataUrlBytes(dataUrl: string | null | undefined): number {
  if (!dataUrl) return 0
  const i = dataUrl.indexOf(',')
  if (i < 0) return 0
  const b64 = dataUrl.slice(i + 1)
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - pad)
}

/** Bytes the data URL occupies inside the Firestore document (1 byte per ASCII character). */
export function dataUrlStoredBytes(dataUrl: string | null | undefined): number {
  return dataUrl ? dataUrl.length : 0
}

/** Image size guard: null when OK, otherwise a message. */
export function imageSizeError(dataUrl: string | null | undefined, max = MAX_IMAGE_BYTES): string | null {
  if (!dataUrl) return null
  if (!/^data:image\/(png|jpeg|webp|gif);base64,/.test(dataUrl)) return 'Unsupported image data. Use PNG or JPEG.'
  const n = dataUrlStoredBytes(dataUrl)
  return n > max ? `Image is ${formatBytes(n)} - the limit is ${formatBytes(max)}.` : null
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** Largest size that fits inside maxW × maxH keeping the aspect ratio (never upscales). */
export function fitWithin(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
  if (w <= 0 || h <= 0) return { width: 0, height: 0 }
  const scale = Math.min(1, maxW / w, maxH / h)
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/

/** Field → message. Empty object = valid. */
export function validateBranding(b: Branding, sessionTimeoutMin: number): Record<string, string> {
  const e: Record<string, string> = {}
  if (!b.companyName.trim()) e.companyName = 'Enter the company name.'
  for (const k of ['email', 'supportEmail'] as const) if (b[k].trim() && !EMAIL_RE.test(b[k].trim())) e[k] = 'Enter a valid e-mail address.'
  if (b.website.trim() && !/^https?:\/\/\S+$/i.test(b.website.trim()) && !/^[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(b.website.trim())) e.website = 'Enter a web address such as digitaltarget.pk.'
  if (!/^[A-Z]{3}$/i.test(b.currency.trim())) e.currency = 'Use a 3-letter currency code such as PKR.'
  for (const k of ['invoicePrefix', 'receiptPrefix'] as const) {
    if (!b[k].trim()) e[k] = 'Enter a prefix.'
    else if (!/^[A-Za-z0-9/_-]{1,12}$/.test(b[k].trim())) e[k] = 'Up to 12 letters, digits, - / _ (no spaces).'
  }
  if (!Number.isFinite(b.taxRate) || b.taxRate < 0 || b.taxRate > 100) e.taxRate = 'Tax rate must be between 0 and 100 %.'
  if (b.supportWhatsapp.trim() && !/^\d{10,15}$/.test(b.supportWhatsapp.trim())) e.supportWhatsapp = 'International number, digits only (e.g. 923451873354).'
  if (b.iban.trim() && !/^[A-Z]{2}\d{2}[A-Z0-9 ]{8,32}$/i.test(b.iban.trim())) e.iban = 'IBAN starts with the country code, e.g. PK36SCBL0000001123456702.'
  if (b.verifyBaseUrl.trim() && !/^https?:\/\/[^\s/]+(\/\S*)?$/i.test(b.verifyBaseUrl.trim())) e.verifyBaseUrl = 'Enter a full address such as https://dt-solar.web.app (or leave empty).'
  if (b.mapTileUrl.trim()) {
    if (!/^https:\/\//i.test(b.mapTileUrl.trim())) e.mapTileUrl = 'Tile URLs must use https://.'
    else if (!['{z}', '{x}', '{y}'].every((p) => b.mapTileUrl.includes(p))) e.mapTileUrl = 'The tile URL must contain {z}, {x} and {y}.'
  }
  if (b.invoiceFooter.length > 500) e.invoiceFooter = 'Keep the footer under 500 characters.'
  if (b.terms.length > 3000) e.terms = 'Keep the terms under 3000 characters.'
  for (const k of IMAGE_FIELDS) {
    const err = imageSizeError(b[k])
    if (err) e[k] = err
  }
  if (!Number.isInteger(sessionTimeoutMin) || sessionTimeoutMin < MIN_SESSION_TIMEOUT_MIN || sessionTimeoutMin > MAX_SESSION_TIMEOUT_MIN) {
    e.sessionTimeoutMin = `Between ${MIN_SESSION_TIMEOUT_MIN} and ${MAX_SESSION_TIMEOUT_MIN} minutes.`
  }
  return e
}

/** Names of the fields that differ (for the activity log). Images are compared by content. */
export function changedBrandingFields(a: Branding, b: Branding): (keyof Branding)[] {
  return (Object.keys(DEFAULT_BRANDING) as (keyof Branding)[]).filter((k) => a[k] !== b[k])
}

export function clampSessionTimeout(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : DEFAULT_SESSION_TIMEOUT_MIN
  return Math.min(MAX_SESSION_TIMEOUT_MIN, Math.max(MIN_SESSION_TIMEOUT_MIN, n))
}

/** Masks a customer name for the public verify page: "Wetco Solar" → "W**** S****". */
export function maskName(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w.length <= 1 ? w : w[0] + '*'.repeat(Math.min(6, w.length - 1))))
    .join(' ')
}

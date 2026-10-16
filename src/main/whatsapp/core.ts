/**
 * WhatsApp helpers without Electron dependencies (owner: assist area): phone normalisation, URL builders,
 * navigation allow-list, message templates, duplicate guard and the outbox drag-token store.
 * The app never automates WhatsApp: it only opens a chat URL and lets the user drag the PDF and press Send.
 */
import { randomBytes } from 'crypto'
import { basename } from 'path'

export const WHATSAPP_WEB_URL = 'https://web.whatsapp.com/'
/** A current desktop Chrome user agent (WhatsApp Web rejects the default Electron UA). */
export const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
export const DEDUPE_MINUTES = 10

export type WaEntity = 'document' | 'payment' | 'project' | 'statement' | 'material'
export const WA_ENTITIES: WaEntity[] = ['document', 'payment', 'project', 'statement', 'material']
/** Print route kind for each entity (see renderToPdf). */
export const PRINT_KIND: Record<WaEntity, string> = { document: 'doc', payment: 'payment', project: 'project', statement: 'statement', material: 'material' }

/**
 * Normalises a phone number to international digits without '+' (e.g. 03001234567 -> 923001234567).
 * Returns null when the result is not a plausible number (8..15 digits).
 */
export function normalizePhone(raw: unknown, countryCode = '92'): string | null {
  const cc = String(countryCode ?? '').replace(/\D/g, '') || '92'
  let s = String(raw ?? '').trim()
  if (!s) return null
  const plus = s.startsWith('+')
  let d = s.replace(/\D/g, '')
  if (!d) return null
  if (plus) {
    // already international
  } else if (d.startsWith('00')) {
    d = d.slice(2)
  } else if (d.startsWith('0')) {
    d = cc + d.replace(/^0+/, '')
  } else if (!d.startsWith(cc) && d.length <= 10) {
    d = cc + d
  }
  s = d
  if (s.length < 8 || s.length > 15 || s.startsWith('0')) return null
  // Pakistan mobile numbers: 92 + 3xx xxxxxxx (10 digits after the code)
  if (s.startsWith('92') && s[2] === '3' && s.length !== 12) return null
  return s
}

/** Chat URL inside WhatsApp Web (base is web.whatsapp.com or the test override). */
export function buildSendUrl(phone: string, text = '', base = WHATSAPP_WEB_URL): string {
  const b = base.endsWith('/') ? base : `${base}/`
  return `${b}send?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(text)}`
}

/** wa.me chat link for the desktop WhatsApp app / browser. */
export function buildChatLink(phone: string, text = ''): string {
  return `https://wa.me/${encodeURIComponent(phone)}${text ? `?text=${encodeURIComponent(text)}` : ''}`
}

/** Navigation allow-list for the WhatsApp view: only WhatsApp hosts over https (plus an explicit test origin). */
export function isAllowedWhatsAppUrl(url: string, testOrigin?: string | null): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (testOrigin) {
    try {
      if (u.origin === new URL(testOrigin).origin) return true
    } catch {
      /* ignore bad override */
    }
  }
  if (u.protocol === 'blob:' || u.protocol === 'about:') return url === 'about:blank' || url.startsWith('blob:https://web.whatsapp.com/')
  if (u.protocol !== 'https:') return false
  const h = u.hostname.toLowerCase()
  return h === 'whatsapp.com' || h.endsWith('.whatsapp.com') || h === 'whatsapp.net' || h.endsWith('.whatsapp.net')
}

export function dedupeKey(entity: string, id: number, phone: string): string {
  return `${entity}:${id}:${phone}`
}

/** True when a previous attempt with the same key was opened or sent within the guard window. */
export function isRecentDuplicate(rows: Array<{ status: string; created_at: string }>, now: Date, minutes = DEDUPE_MINUTES): boolean {
  const limit = now.getTime() - minutes * 60_000
  return rows.some((r) => (r.status === 'opened' || r.status === 'sent') && new Date(r.created_at.replace(' ', 'T')).getTime() >= limit)
}

export interface TemplateInfo {
  firmName: string
  partyName?: string | null
  label: string
  number?: string | null
  amount?: string | null
  balance?: string | null
  from?: string | null
  to?: string | null
}

/** Default message per entity (editable by the user before sending). */
export function messageTemplate(entity: WaEntity, i: TemplateInfo): string {
  const hello = i.partyName ? `Dear ${i.partyName},` : 'Assalam o Alaikum,'
  const thanks = `Thank you,\n${i.firmName}`
  switch (entity) {
    case 'document':
      return `${hello}\nPlease find attached ${i.label} ${i.number ?? ''}${i.amount ? ` for ${i.amount}` : ''}.${i.balance ? `\nBalance due: ${i.balance}` : ''}\n${thanks}`
    case 'payment':
      return `${hello}\nPlease find attached ${i.label} ${i.number ?? ''}${i.amount ? ` of ${i.amount}` : ''}.\n${thanks}`
    case 'statement':
      return `${hello}\nPlease find attached your account statement${i.from && i.to ? ` from ${i.from} to ${i.to}` : ''}.${i.balance ? `\nCurrent balance: ${i.balance}` : ''}\n${thanks}`
    case 'project':
      return `${hello}\nPlease find attached the statement of your solar project ${i.number ?? ''}.${i.balance ? `\nBalance due: ${i.balance}` : ''}\n${thanks}`
    case 'material':
      return `${hello}\nPlease find attached material note ${i.number ?? ''}.\n${thanks}`
  }
}

/** File-system safe PDF name. */
export function safeFileName(name: string): string {
  const base = basename(String(name ?? ''))
    .replace(/[^A-Za-z0-9._ -]+/g, '-')
    .replace(/\s+/g, '_')
    .replace(/-+/g, '-')
    .replace(/^[.-]+/, '')
    .slice(0, 80)
  return (base || 'document').replace(/\.pdf$/i, '') + '.pdf'
}

/** In-memory map of short random tokens to outbox files (the renderer never sees file paths). */
export class DragTokens {
  private map = new Map<string, { file: string; expires: number }>()
  constructor(private ttlMs = 6 * 3600_000) {}

  issue(file: string, now = Date.now()): string {
    const token = randomBytes(12).toString('hex')
    this.map.set(token, { file, expires: now + this.ttlMs })
    return token
  }

  resolve(token: unknown, now = Date.now()): string | null {
    if (typeof token !== 'string' || !/^[a-f0-9]{24}$/.test(token)) return null
    const e = this.map.get(token)
    if (!e) return null
    if (e.expires < now) {
      this.map.delete(token)
      return null
    }
    return e.file
  }
}

import { describe, expect, it } from 'vitest'
import { HELP_ARTICLES } from '../src/shared/help/kb'
import { buildIndex, editDistance, search, tokenize } from '../src/shared/help/search'
import {
  DragTokens, buildChatLink, buildSendUrl, dedupeKey, isAllowedWhatsAppUrl, isRecentDuplicate, messageTemplate, normalizePhone, safeFileName
} from '../src/main/whatsapp/core'

const index = buildIndex(HELP_ARTICLES)
const top = (q: string): string | undefined => {
  const r = search(index, q)
  return r.confident ? r.hits[0]?.article.id : undefined
}

describe('help knowledge base', () => {
  it('has at least 45 complete bilingual articles with unique ids', () => {
    expect(HELP_ARTICLES.length).toBeGreaterThanOrEqual(45)
    const ids = new Set<string>()
    for (const a of HELP_ARTICLES) {
      expect(ids.has(a.id), a.id).toBe(false)
      ids.add(a.id)
      expect(a.title.en && a.title.ur && a.summary.en && a.summary.ur && a.path.en && a.path.ur, a.id).toBeTruthy()
      expect(/[؀-ۿ]/.test(a.title.ur + a.summary.ur), a.id).toBe(true)
      expect(a.steps.en.length, a.id).toBeGreaterThanOrEqual(2)
      expect(a.steps.ur.length, a.id).toBe(a.steps.en.length)
      expect(a.keywords.length, a.id).toBeGreaterThan(2)
    }
    for (const a of HELP_ARTICLES) for (const r of a.related) expect(ids.has(r), `${a.id} -> ${r}`).toBe(true)
  })
})

describe('help search', () => {
  it('tokenizes English, Roman Urdu and Urdu to the same concepts', () => {
    expect(tokenize('bill')).toEqual(['invoice'])
    expect(tokenize('انوائس')).toEqual(['invoice'])
    expect(tokenize('maal')).toEqual(['item'])
    expect(tokenize('سامان')).toEqual(['item'])
    expect(tokenize('din band')).toEqual(['day', 'close'])
    expect(editDistance('invoise', 'invoice')).toBe(1)
  })

  const cases: Array<[string, string]> = [
    ['How do I create an invoice?', 'create-invoice'],
    ['invoice kaise banaye', 'create-invoice'],
    ['bill kaise banaen', 'create-invoice'],
    ['انوائس کیسے بنائیں', 'create-invoice'],
    ['convert quotation to invoice', 'convert-quotation'],
    ['کوٹیشن بنانا', 'create-quotation'],
    ['din band kaise karen', 'day-closing'],
    ['دن بند کرنا', 'day-closing'],
    ['close the month', 'month-closing'],
    ['add new product', 'add-product'],
    ['naya maal add karna', 'add-product'],
    ['opening stock', 'opening-stock'],
    ['customer se paise wasool karna', 'receive-payment'],
    ['pay supplier', 'make-payment'],
    ['project profit', 'project-profit'],
    ['پروجیکٹ کا منافع', 'project-profit'],
    ['material issue to site', 'material-issue'],
    ['whatsapp par invoice bhejna', 'whatsapp-send'],
    ['whatsapp qr not loading', 'trouble-whatsapp-qr'],
    ['printer not found', 'trouble-printer'],
    ['pdf blank', 'trouble-pdf-blank'],
    ['password bhool gaya', 'forgot-password'],
    ['پاس ورڈ بھول گیا', 'forgot-password'],
    ['backup kaise lein', 'backup'],
    ['restore backup', 'restore'],
    ['switch firm', 'switch-firm'],
    ['activate license key', 'license-activation'],
    ['dark theme', 'themes'],
    ['app slow hai', 'trouble-slow'],
    ['transfer cash to bank', 'account-transfer'],
    ['serial number warranty', 'serials'],
    // typos
    ['invoise kaise banaye', 'create-invoice'],
    ['quotaton convert', 'convert-quotation'],
    ['printr not found', 'trouble-printer'],
    ['stok adjustmnt', 'stock-adjustment']
  ]
  it.each(cases)('"%s" -> %s', (q, id) => {
    expect(top(q)).toBe(id)
  })

  it('falls back instead of guessing for nonsense', () => {
    expect(search(index, 'zzqx plorb wibble').confident).toBe(false)
    expect(search(index, 'weather in london tomorrow').confident).toBe(false)
    expect(search(index, '').confident).toBe(false)
  })
})

describe('whatsapp helpers', () => {
  it('normalises phone numbers', () => {
    expect(normalizePhone('0300-1234567', '92')).toBe('923001234567')
    expect(normalizePhone('+92 300 1234567', '92')).toBe('923001234567')
    expect(normalizePhone('00923001234567', '92')).toBe('923001234567')
    expect(normalizePhone('3001234567', '92')).toBe('923001234567')
    expect(normalizePhone('923001234567', '92')).toBe('923001234567')
    expect(normalizePhone('+44 7700 900123', '92')).toBe('447700900123')
    expect(normalizePhone('12345', '92')).toBeNull()
    expect(normalizePhone('030012345', '92')).toBeNull()
    expect(normalizePhone('', '92')).toBeNull()
    expect(normalizePhone('abc', '92')).toBeNull()
  })

  it('builds URLs with encoding', () => {
    expect(buildSendUrl('923001234567', 'Hi & bye\nثبت')).toBe('https://web.whatsapp.com/send?phone=923001234567&text=Hi%20%26%20bye%0A%D8%AB%D8%A8%D8%AA')
    expect(buildSendUrl('923001234567', '', 'http://127.0.0.1:5000')).toBe('http://127.0.0.1:5000/send?phone=923001234567&text=')
    expect(buildChatLink('923001234567', 'a b')).toBe('https://wa.me/923001234567?text=a%20b')
    expect(buildChatLink('923001234567')).toBe('https://wa.me/923001234567')
  })

  it('allows only WhatsApp hosts', () => {
    expect(isAllowedWhatsAppUrl('https://web.whatsapp.com/')).toBe(true)
    expect(isAllowedWhatsAppUrl('https://mmg.whatsapp.net/x')).toBe(true)
    expect(isAllowedWhatsAppUrl('http://web.whatsapp.com/')).toBe(false)
    expect(isAllowedWhatsAppUrl('https://evilwhatsapp.com/')).toBe(false)
    expect(isAllowedWhatsAppUrl('https://web.whatsapp.com.evil.io/')).toBe(false)
    expect(isAllowedWhatsAppUrl('file:///etc/passwd')).toBe(false)
    expect(isAllowedWhatsAppUrl('http://127.0.0.1:5000/send', 'http://127.0.0.1:5000/')).toBe(true)
    expect(isAllowedWhatsAppUrl('http://127.0.0.1:5001/', 'http://127.0.0.1:5000/')).toBe(false)
  })

  it('guards duplicates within 10 minutes', () => {
    const now = new Date('2026-01-01T10:00:00')
    expect(dedupeKey('document', 5, '923001234567')).toBe('document:5:923001234567')
    expect(isRecentDuplicate([{ status: 'opened', created_at: '2026-01-01 09:55:00' }], now)).toBe(true)
    expect(isRecentDuplicate([{ status: 'sent', created_at: '2026-01-01 09:49:00' }], now)).toBe(false)
    expect(isRecentDuplicate([{ status: 'prepared', created_at: '2026-01-01 09:59:00' }], now)).toBe(false)
    expect(isRecentDuplicate([{ status: 'failed', created_at: '2026-01-01 09:59:00' }], now)).toBe(false)
  })

  it('builds message templates', () => {
    const m = messageTemplate('document', { firmName: 'WETCO', partyName: 'Ali', label: 'Sales Invoice', number: 'INV-1', amount: 'Rs 1,000', balance: 'Rs 500' })
    expect(m).toContain('Dear Ali')
    expect(m).toContain('Sales Invoice INV-1 for Rs 1,000')
    expect(m).toContain('Balance due: Rs 500')
    expect(m).toContain('WETCO')
    expect(messageTemplate('statement', { firmName: 'W', label: 'Statement', from: '2026-01-01', to: '2026-01-31' })).toContain('from 2026-01-01 to 2026-01-31')
  })

  it('issues and validates drag tokens', () => {
    const t = new DragTokens(1000)
    const tok = t.issue('/x/a.pdf', 0)
    expect(tok).toMatch(/^[a-f0-9]{24}$/)
    expect(t.resolve(tok, 10)).toBe('/x/a.pdf')
    expect(t.resolve(tok, 2000)).toBeNull()
    expect(t.resolve('../../etc', 0)).toBeNull()
    expect(t.resolve(123, 0)).toBeNull()
    expect(safeFileName('../INV/0001 <x>.pdf')).toBe('0001_-x-.pdf')
    expect(safeFileName('')).toBe('document.pdf')
  })
})

describe('whatsapp send log (database)', () => {
  it('builds drafts, guards duplicates and only marks sent by the user', async () => {
    const { setupCtx, userCtx, warehouse } = await import('./helpers')
    const { saveParty } = await import('../src/main/services/parties')
    const { saveProduct } = await import('../src/main/services/inventory')
    const { createDocument } = await import('../src/main/services/documents')
    const svc = await import('../src/main/whatsapp/service')
    const ctx = setupCtx()
    const cust = saveParty(ctx, { type: 'customer', name: 'Ali Khan', phone: '0300-1234567' } as never)
    const prod = saveProduct(ctx, { name: 'Panel', salePrice: 1000 } as never)
    const inv = createDocument(ctx, { docType: 'sale_invoice', date: '2026-01-03', partyId: cust, warehouseId: warehouse(ctx), deductStock: false, lines: [{ productId: prod, description: 'Panel', qty: 2, rate: 1000 }] } as never)

    const d = svc.buildDraft(ctx, svc.parseTarget({ entity: 'document', id: inv }))
    expect(d.phone).toBe('923001234567')
    expect(d.partyName).toBe('Ali Khan')
    expect(d.message).toContain('Dear Ali Khan')
    expect(d.message).toContain('Sales Invoice')
    expect(d.fileName).toMatch(/^Sales_Invoice-.+\.pdf$/)
    expect(d.printKind).toBe('doc')
    expect(d.mode).toBe('web')
    expect(() => svc.parseTarget({ entity: 'evil', id: 1 })).toThrow()
    expect(() => svc.parseTarget({ entity: 'statement', id: 1, params: { from: "1' OR 1" } })).toThrow()

    const st = svc.buildDraft(ctx, svc.parseTarget({ entity: 'statement', id: cust, params: { from: '2026-01-01', to: '2026-01-31' } }))
    expect(st.message).toContain('from 2026-01-01 to 2026-01-31')

    expect(svc.recentDuplicate(ctx, 'document', inv, d.phone)).toBeNull()
    const id = svc.insertLog(ctx, { entity: 'document', id: inv, partyId: cust, phone: d.phone, fileName: d.fileName, method: 'whatsapp_web', status: 'prepared' })
    expect(svc.recentDuplicate(ctx, 'document', inv, d.phone)).toBeNull() // prepared only
    svc.setLogStatus(ctx, id, 'opened')
    expect(svc.recentDuplicate(ctx, 'document', inv, d.phone)?.id).toBe(id)
    expect(svc.recentDuplicate(ctx, 'document', inv, '923331112222')).toBeNull()
    expect(svc.setLogStatus(ctx, id, 'sent').status).toBe('sent')
    expect(() => svc.setLogStatus(ctx, id, 'failed', 'x')).toThrow()
    expect(svc.listLog(ctx, { status: 'sent' }).map((r) => r.id)).toEqual([id])
    expect(svc.listLog(ctx, { q: 'Ali' })[0].party_name).toBe('Ali Khan')

    const inv2 = userCtx(ctx, 'Inventory Manager', 'stock1')
    expect(() => svc.buildDraft(inv2, svc.parseTarget({ entity: 'document', id: inv }))).toThrow()
  })
})

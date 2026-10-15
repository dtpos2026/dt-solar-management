/**
 * Super Admin portal — licensing area: pure logic (no Firebase).
 * Certificates signed with the admin panel's own code are verified with the desktop verifier.
 */
import { generateKeyPairSync } from 'crypto'
import { describe, expect, it } from 'vitest'
import {
  ONLINE_MS,
  RECENT_MS,
  billingSummary,
  bucketByMonth,
  countLicenseBuckets,
  countOnline,
  licenseBucket,
  monthRange,
  niceMax,
  onlineState,
  paginate,
  paymentStatusFromInvoices
} from '../admin-panel/src/lib/stats'
import { blankClient, clientFromLicense, clientFromRegistration, dataUrlBytes, formatClientCode, hardDeleteGuard, matchClient, validateClient } from '../admin-panel/src/lib/clients'
import {
  addMonthsClamped,
  buildCertPayload,
  certTermsChanged,
  detachEligibility,
  deviceLimitGuard,
  firmLimitGuard,
  holdsSlot,
  planTermsError,
  suggestExpiry,
  suggestRenewal,
  type CertTerms
} from '../admin-panel/src/lib/terms'
import { filterDeviceRows, mergeDeviceRows, slotsUsed, sortDeviceRows, validLocation, type HeartbeatLike, type LicenseInfo } from '../admin-panel/src/lib/devices'
import { loadKey, signPayload, verifyCode } from '../admin-panel/src/lib/crypto'
import { evaluate, parseCertificate, verifyCertificate } from '../src/main/license/verify'

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime() // 15 Oct 2026 12:00 local

describe('online status thresholds', () => {
  it('online < 30 min, recent < 24 h, otherwise offline', () => {
    expect(ONLINE_MS).toBe(30 * MIN)
    expect(RECENT_MS).toBe(DAY)
    expect(onlineState(NOW - 29 * MIN, NOW)).toBe('online')
    expect(onlineState(NOW - 30 * MIN, NOW)).toBe('recent')
    expect(onlineState(NOW - 23 * HOUR, NOW)).toBe('recent')
    expect(onlineState(NOW - DAY, NOW)).toBe('offline')
    expect(onlineState(NOW - 40 * DAY, NOW)).toBe('offline')
    expect(onlineState(NOW + 2 * MIN, NOW)).toBe('online') // clock skew
    expect(onlineState(null, NOW)).toBe('never')
    expect(onlineState(undefined, NOW)).toBe('never')
  })
  it('counts devices per state', () => {
    expect(countOnline([NOW - MIN, NOW - 2 * HOUR, NOW - 3 * DAY, null, NOW - 5 * MIN], NOW)).toEqual({ online: 2, recent: 1, offline: 1, never: 1 })
  })
})

describe('metric aggregation', () => {
  const lic = (o: Partial<{ status: string; expiresAtMs: number | null; activeDevices: number; everActivated: boolean }>) => ({
    status: 'active',
    expiresAtMs: null,
    activeDevices: 1,
    everActivated: true,
    ...o
  })
  it('buckets licenses: active / pending / suspended / revoked / expired', () => {
    expect(licenseBucket(lic({}), NOW)).toBe('active')
    expect(licenseBucket(lic({ activeDevices: 0, everActivated: false }), NOW)).toBe('pending')
    // all devices released later: still counted as active (a device was activated once)
    expect(licenseBucket(lic({ activeDevices: 0, everActivated: true }), NOW)).toBe('active')
    expect(licenseBucket(lic({ expiresAtMs: NOW - 1 }), NOW)).toBe('expired')
    expect(licenseBucket(lic({ expiresAtMs: NOW - 1, activeDevices: 0, everActivated: false }), NOW)).toBe('expired')
    expect(licenseBucket(lic({ status: 'suspended', expiresAtMs: NOW - 1 }), NOW)).toBe('suspended')
    expect(licenseBucket(lic({ status: 'revoked' }), NOW)).toBe('revoked')
    const sample = [lic({}), lic({}), lic({ activeDevices: 0, everActivated: false }), lic({ status: 'suspended' }), lic({ status: 'revoked' }), lic({ expiresAtMs: NOW - DAY })]
    expect(countLicenseBuckets(sample, NOW)).toEqual({ active: 2, pending: 1, suspended: 1, revoked: 1, expired: 1, total: 6 })
  })

  it('billing summary from invoices and payments', () => {
    const inv = (o: Record<string, unknown>) => ({ status: 'unpaid', total: 0, paid: 0, balance: 0, issueDateMs: NOW, dueDateMs: NOW + DAY, ...o })
    const invoices = [
      inv({ status: 'paid', total: 50000, paid: 50000, balance: 0, issueDateMs: NOW - 40 * DAY }),
      inv({ status: 'partial', total: 30000, paid: 10000, balance: 20000, dueDateMs: NOW - DAY }),
      inv({ status: 'unpaid', total: 15000, paid: 0, balance: 15000 }),
      inv({ status: 'cancelled', total: 99999, paid: 0, balance: 99999 })
    ]
    const payments = [
      { amount: 50000, dateMs: NOW - 40 * DAY },
      { amount: 10000, dateMs: NOW - 2 * DAY },
      { amount: 7000, dateMs: NOW - 3 * DAY, cancelled: true }
    ]
    const s = billingSummary(invoices, payments, NOW)
    expect(s.sales).toBe(95000)
    expect(s.invoiceCount).toBe(3)
    expect(s.paidCount).toBe(1)
    expect(s.collected).toBe(60000)
    expect(s.outstandingCount).toBe(2)
    expect(s.outstanding).toBe(35000)
    expect(s.overdueCount).toBe(1)
    expect(s.overdue).toBe(20000)
    expect(s.revenueThisMonth).toBe(10000)
    expect(s.invoicedThisMonth).toBe(45000)
    // unknown payments are reported as unknown, never as 0
    expect(billingSummary(invoices, null, NOW).revenueThisMonth).toBeNull()
    expect(billingSummary([], [], NOW)).toMatchObject({ sales: 0, invoiceCount: 0, outstanding: 0, revenueThisMonth: 0 })
  })

  it('license payment status from its invoices', () => {
    const inv = (status: string, paid: number, balance: number) => ({ status, total: paid + balance, paid, balance, issueDateMs: NOW, dueDateMs: null })
    expect(paymentStatusFromInvoices([])).toBe('none')
    expect(paymentStatusFromInvoices([inv('cancelled', 0, 100)])).toBe('none')
    expect(paymentStatusFromInvoices([inv('paid', 100, 0)])).toBe('paid')
    expect(paymentStatusFromInvoices([inv('paid', 100, 0), inv('partial', 10, 90)])).toBe('partial')
    expect(paymentStatusFromInvoices([inv('unpaid', 0, 100)])).toBe('unpaid')
  })

  it('monthly buckets for charts (inclusive range, values summed)', () => {
    const from = new Date(2026, 6, 10).getTime() // 10 Jul
    const to = NOW // 15 Oct
    const months = monthRange(from, to)
    expect(months.map((m) => m.key)).toEqual(['2026-07', '2026-08', '2026-09', '2026-10'])
    expect(months[0].label).toBe('Jul 26')
    const items = [
      { at: new Date(2026, 6, 1).getTime(), v: 5 }, // before range start → excluded
      { at: new Date(2026, 6, 20).getTime(), v: 100 },
      { at: new Date(2026, 6, 31, 23).getTime(), v: 50 },
      { at: new Date(2026, 8, 3).getTime(), v: 25.5 },
      { at: null, v: 999 }
    ]
    const b = bucketByMonth(items, from, to, (i) => i.at, (i) => i.v)
    expect(b.map((x) => x.value)).toEqual([150, 0, 25.5, 0])
    expect(bucketByMonth(items, from, to, (i) => i.at).map((x) => x.value)).toEqual([2, 0, 1, 0])
    expect(monthRange(to, from)).toEqual([])
    expect(niceMax(0)).toBe(1)
    expect(niceMax(73)).toBe(100)
    expect(niceMax(180000)).toBe(200000)
    expect(niceMax(2300)).toBe(2500)
  })

  it('paginates', () => {
    const list = Array.from({ length: 23 }, (_, i) => i)
    expect(paginate(list, 1, 10)).toMatchObject({ rows: list.slice(0, 10), page: 1, pages: 3, from: 1, to: 10 })
    expect(paginate(list, 3, 10)).toMatchObject({ rows: [20, 21, 22], page: 3, from: 21, to: 23 })
    expect(paginate(list, 9, 10).page).toBe(3)
    expect(paginate([], 1, 10)).toMatchObject({ rows: [], page: 1, pages: 1, from: 0, to: 0 })
  })
})

describe('plan expiry suggestion', () => {
  it('monthly +1 month, yearly +1 year, lifetime none (end of day)', () => {
    const from = new Date(2026, 9, 15, 10, 30)
    const m = suggestExpiry('monthly', from)!
    expect([m.getFullYear(), m.getMonth(), m.getDate(), m.getHours(), m.getMinutes()]).toEqual([2026, 10, 15, 23, 59])
    const y = suggestExpiry('yearly', from)!
    expect([y.getFullYear(), y.getMonth(), y.getDate()]).toEqual([2027, 9, 15])
    expect(suggestExpiry('lifetime', from)).toBeNull()
  })
  it('clamps month ends and leap days', () => {
    const jan31 = addMonthsClamped(new Date(2027, 0, 31), 1)
    expect([jan31.getMonth(), jan31.getDate()]).toEqual([1, 28])
    const leap = addMonthsClamped(new Date(2028, 1, 29), 12)
    expect([leap.getFullYear(), leap.getMonth(), leap.getDate()]).toEqual([2029, 1, 28])
  })
  it('renewal extends from the current expiry when it is still in the future', () => {
    const future = new Date(2026, 11, 1, 23, 59, 59).getTime()
    const r = suggestRenewal('yearly', future, NOW)!
    expect([r.getFullYear(), r.getMonth(), r.getDate()]).toEqual([2027, 11, 1])
    const past = new Date(2026, 0, 1).getTime()
    const r2 = suggestRenewal('monthly', past, NOW)!
    expect([r2.getFullYear(), r2.getMonth(), r2.getDate()]).toEqual([2026, 10, 15])
    expect(suggestRenewal('lifetime', past, NOW)).toBeNull()
  })
  it('plan type and expiry must agree', () => {
    expect(planTermsError('lifetime', null)).toBeNull()
    expect(planTermsError('lifetime', NOW)).toMatch(/no expiry/)
    expect(planTermsError('yearly', null)).toMatch(/needs an expiry/)
    expect(planTermsError('monthly', NOW + DAY)).toBeNull()
  })
})

describe('device-limit guard', () => {
  it('cannot go below the computers holding a slot', () => {
    expect(deviceLimitGuard(3, 2).ok).toBe(true)
    expect(deviceLimitGuard(2, 2).ok).toBe(true)
    const g = deviceLimitGuard(1, 3)
    expect(g.ok).toBe(false)
    expect(g.reason).toMatch(/Release 2 computer/)
    expect(deviceLimitGuard(0, 0).ok).toBe(false)
    expect(deviceLimitGuard(1.5, 0).ok).toBe(false)
    expect(firmLimitGuard(5).ok).toBe(true)
    expect(firmLimitGuard(0).ok).toBe(false)
  })
  it('active, suspended and revoked devices hold a slot; released ones do not', () => {
    expect(['active', 'suspended', 'revoked', 'deactivated'].map(holdsSlot)).toEqual([true, true, true, false])
    expect(slotsUsed([{ status: 'active' }, { status: 'suspended' }, { status: 'deactivated' }, { status: 'revoked' }])).toBe(3)
  })
})

describe('detach eligibility', () => {
  const base = { planType: 'lifetime' as const, expiresAtMs: null, status: 'active', detached: false }
  it('only a valid active lifetime license without expiry', () => {
    expect(detachEligibility(base, NOW)).toEqual({ ok: true, reasons: [] })
    expect(detachEligibility({ ...base, planType: 'yearly' }, NOW).ok).toBe(false)
    expect(detachEligibility({ ...base, expiresAtMs: NOW + DAY }, NOW).ok).toBe(false)
    expect(detachEligibility({ ...base, expiresAtMs: NOW - DAY }, NOW).reasons.join(' ')).toMatch(/expired/)
    expect(detachEligibility({ ...base, status: 'suspended' }, NOW).ok).toBe(false)
    expect(detachEligibility({ ...base, status: 'revoked' }, NOW).ok).toBe(false)
    expect(detachEligibility({ ...base, detached: true }, NOW).reasons[0]).toMatch(/already detached/)
  })
})

describe('certificate payload for refresh / detach (verified by the desktop)', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const key = await loadKey(privatePem)
  const deviceId = 'A1B2-C3D4-E5F6-0718-293A-4B5C'
  const terms: CertTerms = {
    licenseId: 'LicAbcdefghij0123456',
    customerName: 'Ahmed Khan',
    businessName: 'WETCO SOLAR SOLUTIONS',
    phone: '03001234567',
    email: 'wetco@example.com',
    plan: 'professional',
    planType: 'yearly',
    clientId: 'client123',
    maxFirms: 5,
    maxUsers: 10,
    maxDevices: 2,
    features: ['multi_firm', 'projects'],
    expiresAtMs: NOW + 300 * DAY,
    graceDays: 15,
    checkinDays: 30,
    poweredBy: true,
    detached: false
  }
  const evalBase = { now: NOW, certError: null, trialStartedAt: NOW - 100 * DAY, lastSeenAt: NOW, lastCheckAt: NOW - DAY }

  it('the admin key matches the PEM pair', () => {
    expect(key.publicPem.replace(/\s+/g, '')).toBe(publicPem.replace(/\s+/g, ''))
  })

  it('refreshed certificate (renewal) verifies and carries the v1.1 terms', async () => {
    const renewed = { ...terms, expiresAtMs: NOW + 700 * DAY, maxFirms: 7 }
    const payload = buildCertPayload(renewed, deviceId, new Date(NOW))
    const cert = await signPayload(payload, key.seed)
    expect(await verifyCode(cert.code, key.publicKey)).toBe(true)
    // compact activation code (what licenseStatus.certs[deviceId] holds) and the .dtlic file both verify
    for (const text of [cert.code, cert.fileContents]) {
      const r = verifyCertificate(parseCertificate(text), publicPem, deviceId)
      expect(r.ok).toBe(true)
      if (!r.ok) continue
      expect(r.payload).toMatchObject({ licenseId: terms.licenseId, maxFirms: 7, maxDevices: 2, planType: 'yearly', clientId: 'client123', poweredBy: true, detached: false, checkinDays: 30 })
      expect(Date.parse(r.payload.expiresAt!)).toBe(NOW + 700 * DAY)
      expect(evaluate({ ...evalBase, payload: r.payload, remoteStatus: null }).mode).toBe('active')
      // managed licenses still obey remote suspension
      expect(evaluate({ ...evalBase, payload: r.payload, remoteStatus: 'suspended' }).mode).toBe('suspended')
    }
    expect(verifyCertificate(parseCertificate(cert.code), publicPem, 'OTHER-DEVICE-123').ok).toBe(false)
  })

  it('detached certificate: lifetime, checkinDays 0, ignores remote status and check-ins', async () => {
    const lifetime: CertTerms = { ...terms, planType: 'lifetime', expiresAtMs: null, detached: true }
    const payload = buildCertPayload(lifetime, deviceId, new Date(NOW - 400 * DAY))
    expect(payload).toMatchObject({ detached: true, checkinDays: 0, expiresAt: null, leaseUntil: null })
    const cert = await signPayload(payload, key.seed)
    const r = verifyCertificate(parseCertificate(cert.code), publicPem, deviceId)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(evaluate({ ...evalBase, payload: r.payload, remoteStatus: 'revoked' }).mode).toBe('active')
    expect(evaluate({ ...evalBase, payload: r.payload, remoteStatus: 'suspended', lastCheckAt: null }).mode).toBe('active')
    // the same terms without detachment would be revoked / overdue
    const managed = buildCertPayload({ ...lifetime, detached: false }, deviceId, new Date(NOW - 400 * DAY))
    expect(evaluate({ ...evalBase, payload: managed, remoteStatus: 'revoked' }).mode).toBe('revoked')
    expect(evaluate({ ...evalBase, payload: managed, remoteStatus: null, lastCheckAt: null }).mode).toBe('lease_expired')
  })

  it('refuses to build a detached certificate with an expiry', () => {
    expect(() => buildCertPayload({ ...terms, detached: true }, deviceId)).toThrow(/lifetime/)
  })

  it('detects which certificate terms changed', () => {
    expect(certTermsChanged(terms, { ...terms })).toEqual([])
    expect(certTermsChanged(terms, { ...terms, maxDevices: 3, features: ['projects', 'multi_firm'] })).toEqual(['maxDevices'])
    expect(certTermsChanged(terms, { ...terms, poweredBy: false, features: ['projects'] })).toEqual(['poweredBy', 'features'])
  })
})

describe('clients', () => {
  it('formats client codes from the counter', () => {
    expect(formatClientCode(1)).toBe('DTC-0001')
    expect(formatClientCode(42)).toBe('DTC-0042')
    expect(formatClientCode(9999)).toBe('DTC-9999')
    expect(formatClientCode(12345)).toBe('DTC-12345')
    expect(formatClientCode(0)).toBe('DTC-0001')
    expect(formatClientCode(Number.NaN)).toBe('DTC-0001')
  })
  it('validates client input', () => {
    const ok = { ...blankClient(), company: 'WETCO', phone: '+92 300 1234567', email: 'a@b.pk' }
    expect(validateClient(ok)).toEqual({})
    const bad = validateClient({ ...blankClient(), company: ' ', phone: 'abc', email: 'nope', allowedFirms: 0, allowedDevices: 1.5, logo: 'data:text/html;base64,AAAA' })
    expect(Object.keys(bad).sort()).toEqual(['allowedDevices', 'allowedFirms', 'company', 'email', 'logo', 'phone'])
    const big = 'data:image/png;base64,' + 'A'.repeat(300_000)
    expect(dataUrlBytes(big)).toBe(225_000)
    expect(validateClient({ ...ok, logo: big }).logo).toMatch(/200 KB/)
  })
  it('hard delete only for the owner and only when nothing links to the client', () => {
    expect(hardDeleteGuard({ isOwner: false, linkedLicenses: 0, linkedInvoices: 0 }).ok).toBe(false)
    expect(hardDeleteGuard({ isOwner: true, linkedLicenses: 1, linkedInvoices: 0 }).reason).toMatch(/1 license/)
    expect(hardDeleteGuard({ isOwner: true, linkedLicenses: 0, linkedInvoices: 2 }).ok).toBe(false)
    expect(hardDeleteGuard({ isOwner: true, linkedLicenses: 0, linkedInvoices: 0 }).ok).toBe(true)
  })
  it('prefills from a legacy license and from desktop registration details; matches existing clients', () => {
    const c = clientFromLicense({ businessName: 'Sun Power', customerName: 'Ali', phone: '0300', email: '', city: 'Multan', plan: 'enterprise', planType: 'lifetime', maxFirms: 10, maxDevices: 5 })
    expect(c).toMatchObject({ company: 'Sun Power', ownerName: 'Ali', city: 'Multan', plan: 'enterprise', planType: 'lifetime', allowedFirms: 10, allowedDevices: 5, status: 'active' })
    const r = clientFromRegistration({ companyName: ' Bright Solar ', ownerName: 'Sara', phone: '0301-7654321', address: 'Lahore' })
    expect(r).toMatchObject({ company: 'Bright Solar', ownerName: 'Sara', phone: '0301-7654321', address: 'Lahore' })
    const clients = [
      { id: 'a', company: 'Bright Solar', phone: '', status: 'active' },
      { id: 'b', company: 'Other', phone: '+92 301 7654321', status: 'active' },
      { id: 'c', company: 'Gone', phone: '', status: 'archived' }
    ]
    expect(matchClient(clients, { companyName: 'x', phone: '03017654321' })?.id).toBe('b')
    expect(matchClient(clients, { companyName: 'bright solar' })?.id).toBe('a')
    expect(matchClient(clients, { companyName: 'Gone' })).toBeNull()
  })
})

describe('devices merged with heartbeats', () => {
  const L = (o: Partial<LicenseInfo>): LicenseInfo => ({
    id: 'L1',
    licenseKey: 'DTSP-AAAA-BBBB-CCCC-DDDD',
    businessName: 'WETCO',
    customerName: 'Ahmed',
    clientId: 'c1',
    status: 'active',
    expiresAtMs: null,
    activeDevices: 1,
    maxDevices: 2,
    activatedAtMs: NOW - 10 * DAY,
    detached: false,
    ...o
  })
  const hb = (o: Partial<HeartbeatLike>): HeartbeatLike => ({
    deviceId: 'DEV-0000000001',
    licenseId: 'L1',
    deviceName: 'PC-1',
    os: 'win32 10',
    appVersion: '1.1.0',
    companyName: 'WETCO',
    mode: 'active',
    lastCheckAt: new Date(NOW - HOUR).toISOString(),
    lastSeenMs: NOW - 5 * MIN,
    location: null,
    ...o
  })
  const dev = (o: Record<string, unknown>) => ({ deviceId: 'DEV-0000000001', deviceName: 'PC-1', os: 'win32', appVersion: '1.0.0', status: 'active' as const, activatedAtMs: NOW - 9 * DAY, activationType: 'online', ...o })

  it('merges by device id and keeps consented locations only', () => {
    const rows = mergeDeviceRows(
      [L({}), L({ id: 'L2', licenseKey: 'DTSP-2222-2222-2222-2222', businessName: 'Bright', activeDevices: 0, activatedAtMs: null, status: 'suspended' })],
      { L1: [dev({}), dev({ deviceId: 'DEV-0000000002', deviceName: 'PC-2', status: 'suspended' })], L2: [] },
      [
        hb({ location: { lat: 30.2, lng: 71.47, accuracyKm: 25, source: 'approximate', label: 'Multan', consent: true } }),
        hb({ deviceId: 'DEV-0000000002', lastSeenMs: NOW - 3 * DAY, location: { lat: 999, lng: 1, source: 'manual', consent: true } as never }),
        hb({ deviceId: 'DEV-TRIAL-000099', licenseId: '', companyName: 'Trial Co', lastSeenMs: NOW - 2 * HOUR, location: { lat: 31.5, lng: 74.3, source: 'manual', consent: false } as never })
      ],
      NOW,
      { includeUnregistered: true }
    )
    expect(rows).toHaveLength(3)
    const r1 = rows.find((r) => r.deviceId === 'DEV-0000000001')!
    expect(r1).toMatchObject({ online: 'online', deviceStatus: 'active', licenseStatus: 'active', appVersion: '1.1.0', company: 'WETCO' })
    expect(r1.location).toMatchObject({ lat: 30.2, lng: 71.47, accuracyKm: 25, source: 'approximate' })
    const r2 = rows.find((r) => r.deviceId === 'DEV-0000000002')!
    expect(r2).toMatchObject({ online: 'offline', deviceStatus: 'suspended', location: null })
    const trial = rows.find((r) => r.deviceStatus === 'unregistered')!
    expect(trial).toMatchObject({ company: 'Trial Co', online: 'recent', licenseStatus: 'none', location: null })
    expect(sortDeviceRows(rows).map((r) => r.online)).toEqual(['online', 'recent', 'offline'])
    expect(filterDeviceRows(rows, { q: 'trial', online: '', deviceStatus: '', licenseStatus: '' })).toHaveLength(1)
    expect(filterDeviceRows(rows, { q: '', online: 'online', deviceStatus: '', licenseStatus: '' })).toHaveLength(1)
    expect(filterDeviceRows(rows, { q: '', online: '', deviceStatus: 'suspended', licenseStatus: '' })).toHaveLength(1)
    expect(mergeDeviceRows([L({})], { L1: [] }, [hb({})], NOW)).toHaveLength(0)
  })

  it('never invents coordinates', () => {
    expect(validLocation(null)).toBeNull()
    expect(validLocation({ lat: 10, lng: 10, source: 'approximate' })).toBeNull() // no consent
    expect(validLocation({ lat: '10', lng: 10, source: 'manual', consent: true })).toBeNull()
    expect(validLocation({ lat: 10, lng: 200, source: 'manual', consent: true })).toBeNull()
    expect(validLocation({ lat: 10, lng: 20, source: 'gps', consent: true })).toBeNull()
    expect(validLocation({ lat: 10, lng: 20, source: 'manual', consent: true, accuracyKm: -1 })).toEqual({ lat: 10, lng: 20, source: 'manual', consent: true, accuracyKm: undefined, label: undefined, updatedAt: undefined })
  })

  it('license status shows detached and pending', () => {
    const rows = mergeDeviceRows([L({ detached: true })], { L1: [dev({})] }, [], NOW)
    expect(rows[0]).toMatchObject({ licenseStatus: 'detached', online: 'never', lastSeenMs: null })
  })
})

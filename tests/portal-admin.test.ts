/**
 * Super Admin portal — pure logic of the portal-admin area (no Firebase): permissions & role presets,
 * license key normalisation / verdicts / browser rate limit, activity-log filters / CSV / retention, branding.
 */
import { describe, expect, it } from 'vitest'
import {
  ADMIN_ROLES,
  ALL_ADMIN_PERMISSIONS,
  OWNER_ONLY_PERMISSIONS,
  ROLE_PRESETS,
  adminActions,
  assignableRoles,
  canGrantPermission,
  effectivePermissions,
  generateTempPassword,
  hasAnyPerm,
  hasPerm,
  isOwnerRole,
  matchPreset,
  permissionCountLabel,
  presetPermissions,
  roleLabel,
  sanitisePermissions,
  validateAdminDraft,
  type AdminDraft
} from '../admin-panel/src/lib/perm'
import {
  KEY_FORMAT_RE,
  checkKeyFormat,
  deriveVerdict,
  isoToMs,
  latestOf,
  maskKey,
  normaliseKeyInput,
  rateLimit,
  verdictInfo,
  VERIFY_LIMIT,
  VERIFY_WINDOW_MS,
  type LicenseFacts
} from '../admin-panel/src/lib/verify'
import {
  AUDIT_CSV_COLUMNS,
  EMPTY_FILTERS,
  RETENTION_DAYS,
  actionLabel,
  auditCsv,
  auditRowFromData,
  chunk,
  csvCell,
  dayEndMs,
  dayStartMs,
  distinctValues,
  filterAuditRows,
  isRetentionDeletable,
  retentionCutoff,
  type AuditRow
} from '../admin-panel/src/lib/auditLog'
import {
  MAX_IMAGE_BYTES,
  changedBrandingFields,
  clampSessionTimeout,
  cleanBranding,
  dataUrlBytes,
  dataUrlStoredBytes,
  fitWithin,
  formatBytes,
  imageSizeError,
  maskName,
  normaliseBranding,
  publicBranding,
  validateBranding
} from '../admin-panel/src/lib/branding'
import { DEFAULT_BRANDING } from '../admin-panel/src/lib/types'

const DAY = 86_400_000

/* ------------------------------------------------ permissions ------------------------------------------------ */

describe('admin permissions', () => {
  it('owners (and legacy superadmins) hold every permission; others exactly their list', () => {
    expect(isOwnerRole('owner')).toBe(true)
    expect(isOwnerRole('superadmin')).toBe(true)
    expect(isOwnerRole('manager')).toBe(false)
    for (const p of ALL_ADMIN_PERMISSIONS) {
      expect(hasPerm({ role: 'owner', permissions: [] }, p)).toBe(true)
      expect(hasPerm({ role: 'superadmin' }, p)).toBe(true)
    }
    expect(hasPerm({ role: 'sales', permissions: ['clients.view'] }, 'clients.view')).toBe(true)
    expect(hasPerm({ role: 'sales', permissions: ['clients.view'] }, 'clients.manage')).toBe(false)
    expect(hasPerm(null, 'clients.view')).toBe(false)
    expect(hasPerm({ role: 'custom', permissions: 'clients.view' as unknown as string[] }, 'clients.view')).toBe(false)
    expect(hasAnyPerm({ role: 'custom', permissions: ['verify.use'] }, ['licenses.view', 'verify.use'])).toBe(true)
    expect(hasAnyPerm({ role: 'custom', permissions: [] }, ['licenses.view', 'verify.use'])).toBe(false)
  })

  it('matches the permission keys documented in DATA_MODEL.md', () => {
    expect([...ALL_ADMIN_PERMISSIONS].sort()).toEqual(
      [
        'clients.view', 'clients.manage', 'licenses.view', 'licenses.generate', 'licenses.manage', 'devices.view', 'devices.manage',
        'billing.view', 'billing.create', 'billing.payments', 'support.manage', 'audit.view', 'audit.manage', 'branding.manage',
        'admins.manage', 'verify.use'
      ].sort()
    )
  })

  it('role presets: only owners manage admins, every preset is a subset of the known keys', () => {
    expect(ADMIN_ROLES).toEqual(['owner', 'manager', 'sales', 'billing', 'support', 'technical', 'custom'])
    for (const r of ADMIN_ROLES) {
      const perms = presetPermissions(r)
      expect(perms.every((p) => ALL_ADMIN_PERMISSIONS.includes(p))).toBe(true)
      if (r !== 'owner') expect(perms.some((p) => OWNER_ONLY_PERMISSIONS.includes(p))).toBe(false)
    }
    expect(presetPermissions('owner')).toEqual([])
    expect(presetPermissions('custom')).toEqual([])
    expect(presetPermissions('manager')).not.toContain('branding.manage')
    expect(presetPermissions('sales')).toEqual(expect.arrayContaining(['clients.manage', 'licenses.generate', 'billing.create']))
    expect(presetPermissions('sales')).not.toContain('licenses.manage')
    expect(presetPermissions('billing')).toEqual(expect.arrayContaining(['billing.payments']))
    expect(presetPermissions('support')).toContain('support.manage')
    expect(presetPermissions('technical')).toEqual(expect.arrayContaining(['devices.manage', 'licenses.manage']))
    expect(ROLE_PRESETS.sales.label).toBe('Sales Agent')
    expect(roleLabel('superadmin')).toBe('Owner')
    expect(roleLabel('billing')).toBe('Billing Operator')
    expect(roleLabel('technical')).toBe('Technical Administrator')
    expect(roleLabel(undefined)).toBe('Custom')
  })

  it('matchPreset recognises presets regardless of order and falls back to custom', () => {
    expect(matchPreset([...presetPermissions('support')].reverse())).toBe('support')
    expect(matchPreset(['clients.view'])).toBe('custom')
    expect(matchPreset([])).toBe('custom')
  })

  it('sanitises permission arrays (unknown keys, duplicates, wrong types)', () => {
    expect(sanitisePermissions(['verify.use', 'x.y', 'clients.view', 'verify.use', 3])).toEqual(['clients.view', 'verify.use'])
    expect(sanitisePermissions(null)).toEqual([])
    expect(effectivePermissions({ role: 'owner' })).toEqual(ALL_ADMIN_PERMISSIONS)
    expect(effectivePermissions({ role: 'custom', permissions: ['audit.view', 'bogus'] })).toEqual(['audit.view'])
    expect(permissionCountLabel({ role: 'owner' })).toBe('All (owner)')
    expect(permissionCountLabel({ role: 'custom', permissions: ['audit.view'] })).toBe(`1 of ${ALL_ADMIN_PERMISSIONS.length}`)
  })

  it('adminActions mirrors the admins/{uid} rules', () => {
    const owner = { uid: 'o1', role: 'owner' }
    const manager = { uid: 'm1', role: 'custom', permissions: ['admins.manage'] }
    const sales = { uid: 's1', role: 'sales', permissions: presetPermissions('sales') }
    const otherOwner = { uid: 'o2', role: 'owner' }

    // nobody edits themselves
    const self = adminActions(owner, owner)
    expect([self.edit, self.toggleActive, self.remove]).toEqual([false, false, false])
    expect(self.resetPassword).toBe(true)
    // owners do everything to others (delete included)
    expect(adminActions(owner, sales)).toMatchObject({ edit: true, toggleActive: true, remove: true })
    expect(adminActions(owner, otherOwner)).toMatchObject({ edit: true, toggleActive: true, remove: true })
    // admins.manage holders: non-privileged targets only, never delete
    expect(adminActions(manager, sales)).toMatchObject({ edit: true, toggleActive: true, remove: false })
    expect(adminActions(manager, otherOwner)).toMatchObject({ edit: false, toggleActive: false, remove: false })
    expect(adminActions(manager, { uid: 'm2', role: 'custom', permissions: ['admins.manage'] }).edit).toBe(false)
    // without admins.manage: nothing
    expect(adminActions(sales, { uid: 'x', role: 'custom', permissions: [] }).edit).toBe(false)
    expect(adminActions(null, sales).edit).toBe(false)
  })

  it('only owners assign the owner role or grant admins.manage', () => {
    expect(assignableRoles(true)).toContain('owner')
    expect(assignableRoles(false)).not.toContain('owner')
    expect(canGrantPermission(false, 'admins.manage')).toBe(false)
    expect(canGrantPermission(false, 'billing.view')).toBe(true)
    expect(canGrantPermission(true, 'admins.manage')).toBe(true)
  })

  it('validates the admin form', () => {
    const ok: AdminDraft = { name: 'Ali', email: 'ali@example.com', password: 'abcd1234', role: 'sales', permissions: presetPermissions('sales') }
    expect(validateAdminDraft(ok, false, true)).toEqual({})
    expect(validateAdminDraft({ ...ok, name: ' ' }, false, true).name).toBeTruthy()
    expect(validateAdminDraft({ ...ok, email: 'nope' }, false, true).email).toBeTruthy()
    expect(validateAdminDraft({ ...ok, password: 'short1' }, false, true).password).toMatch(/8/)
    expect(validateAdminDraft({ ...ok, password: 'onlyletters' }, false, true).password).toMatch(/letters and numbers/)
    expect(validateAdminDraft({ ...ok, password: '' }, false, true, true).password).toBeTruthy()
    expect(validateAdminDraft({ ...ok, password: 'x' }, false, true, true)).toEqual({}) // linking: current password, any length
    expect(validateAdminDraft({ ...ok, role: 'owner', permissions: [] }, false, true).role).toMatch(/owner/i)
    expect(validateAdminDraft({ ...ok, role: 'owner', permissions: [] }, true, true)).toEqual({})
    expect(validateAdminDraft({ ...ok, role: 'custom', permissions: [] }, true, true).permissions).toBeTruthy()
    expect(validateAdminDraft({ ...ok, role: 'custom', permissions: ['admins.manage'] }, false, true).permissions).toMatch(/owner/i)
    expect(validateAdminDraft({ ...ok, role: 'custom', permissions: ['admins.manage'] }, true, true)).toEqual({})
    // editing: e-mail / password are not re-validated
    expect(validateAdminDraft({ ...ok, email: '', password: '' }, false, false)).toEqual({})
  })

  it('generates temporary passwords with letters and digits', () => {
    for (let i = 0; i < 50; i++) {
      const p = generateTempPassword()
      expect(p).toHaveLength(12)
      expect(p).toMatch(/[A-Za-z]/)
      expect(p).toMatch(/[2-9]/)
      expect(p).not.toMatch(/[01lIoO]/)
    }
    // a degenerate random source still yields a valid password
    const p = generateTempPassword(4, () => 0)
    expect(p.length).toBeGreaterThanOrEqual(8)
    expect(validateAdminDraft({ name: 'a', email: 'a@b.cd', password: p, role: 'sales', permissions: ['verify.use'] }, false, true)).toEqual({})
  })
})

/* ------------------------------------------------ verify key ------------------------------------------------ */

describe('verify key', () => {
  it('normalises spaces, case, unicode dashes and missing dashes', () => {
    expect(normaliseKeyInput(' dtsp-ab12-cd34-ef56-gh78 ')).toBe('DTSP-AB12-CD34-EF56-GH78')
    expect(normaliseKeyInput('DTSP AB12 CD34 EF56 GH78')).toBe('DTSP-AB12-CD34-EF56-GH78')
    expect(normaliseKeyInput('dtspab12cd34ef56gh78')).toBe('DTSP-AB12-CD34-EF56-GH78')
    expect(normaliseKeyInput('DTSP–AB12—CD34‐EF56−GH78')).toBe('DTSP-AB12-CD34-EF56-GH78')
    expect(normaliseKeyInput('DTSP.AB12_CD34 - EF56-GH78')).toBe('DTSP-AB12-CD34-EF56-GH78')
    expect(KEY_FORMAT_RE.test(normaliseKeyInput('dtsp ab12-cd34 ef56gh78'))).toBe(true)
  })

  it('explains format errors', () => {
    expect(checkKeyFormat('dtsp-ab12-cd34-ef56-gh78')).toEqual({ key: 'DTSP-AB12-CD34-EF56-GH78', ok: true, error: null })
    expect(checkKeyFormat('').error).toMatch(/Enter/)
    expect(checkKeyFormat('ABCD-AB12-CD34-EF56-GH78').error).toMatch(/start with DTSP/)
    expect(checkKeyFormat('DTSP-AB12-CD34').error).toMatch(/too short/)
    expect(checkKeyFormat('DTSP-AB12-CD34-EF56-GH78-ZZ').error).toMatch(/too long/)
    expect(checkKeyFormat('DTSP-AB12-CD34-EF56-GH7!').error).toMatch(/Only letters/)
  })

  it('derives the verdict shown for a license', () => {
    const now = Date.UTC(2026, 9, 15)
    const base: LicenseFacts = { status: 'active', expiresAtMs: now + 30 * DAY, activeDevices: 1, activatedAtMs: now - DAY, lastVerifiedAtMs: null, detached: false }
    expect(deriveVerdict(base, now)).toBe('active')
    expect(deriveVerdict({ ...base, expiresAtMs: null }, now)).toBe('active')
    expect(deriveVerdict({ ...base, expiresAtMs: now - 1 }, now)).toBe('expired')
    expect(deriveVerdict({ ...base, status: 'suspended', expiresAtMs: now - 1 }, now)).toBe('suspended')
    expect(deriveVerdict({ ...base, status: 'revoked' }, now)).toBe('revoked')
    expect(deriveVerdict({ ...base, activeDevices: 0, activatedAtMs: null }, now)).toBe('pending')
    expect(deriveVerdict({ ...base, activeDevices: 0, activatedAtMs: null, lastVerifiedAtMs: now - DAY }, now)).toBe('active')
    expect(deriveVerdict({ ...base, detached: true, expiresAtMs: null }, now)).toBe('detached')
    expect(verdictInfo('pending').valid).toBe(true)
    expect(verdictInfo('detached').valid).toBe(true)
    expect(verdictInfo('expired').valid).toBe(false)
    expect(verdictInfo('not_found').label).toMatch(/not found/i)
  })

  it('helpers: latestOf, isoToMs, maskKey', () => {
    expect(latestOf(null, 5, undefined, 3)).toBe(5)
    expect(latestOf(null, undefined)).toBeNull()
    expect(isoToMs('2026-10-15T10:00:00.000Z')).toBe(Date.UTC(2026, 9, 15, 10))
    expect(isoToMs('')).toBeNull()
    expect(isoToMs('garbage')).toBeNull()
    expect(maskKey('DTSP-AB12-CD34-EF56-GH78')).toBe('DTSP-AB12-****-****-GH78')
  })

  it('rate limits to 10 lookups per sliding minute', () => {
    const t0 = 1_000_000
    let h: number[] = []
    for (let i = 0; i < VERIFY_LIMIT; i++) {
      const d = rateLimit(h, t0 + i * 1000)
      expect(d.allowed).toBe(true)
      expect(d.remaining).toBe(VERIFY_LIMIT - i - 1)
      h = d.history
    }
    const blocked = rateLimit(h, t0 + 10_000)
    expect(blocked.allowed).toBe(false)
    expect(blocked.retryAfterMs).toBe(VERIFY_WINDOW_MS - 10_000)
    // the oldest lookup leaves the window → one more is allowed
    expect(rateLimit(h, t0 + VERIFY_WINDOW_MS + 1).allowed).toBe(true)
    // future / junk timestamps are ignored
    expect(rateLimit([t0 + 999_999, NaN as unknown as number], t0).allowed).toBe(true)
  })
})

/* ------------------------------------------------ activity log ------------------------------------------------ */

function row(p: Partial<AuditRow> & { id: string }): AuditRow {
  return auditRowFromData(p.id, {
    action: 'license_created',
    category: 'license',
    by: 'owner@x.com',
    status: 'success',
    archived: false,
    ...p,
    at: p.atMs === undefined ? { toMillis: () => Date.UTC(2026, 9, 1) } : p.atMs === null ? null : { toMillis: () => p.atMs }
  })
}

describe('activity log', () => {
  it('maps legacy entries (no category) to license', () => {
    const r = auditRowFromData('a', { action: 'license_created', by: 'x', licenseId: 'L1', details: 'd', at: { toMillis: () => 5 } })
    expect(r).toMatchObject({ category: 'license', legacy: true, target: 'L1', targetType: 'license', status: 'success', archived: false, atMs: 5 })
    expect(auditRowFromData('b', { category: 'weird' }).category).toBe('general')
    expect(auditRowFromData('c', { category: 'security', status: 'failure', meta: [1] })).toMatchObject({ legacy: false, status: 'failure', meta: {} })
    expect(actionLabel('admin_password_reset_sent')).toBe('Admin password reset sent')
  })

  it('filters by search, admin, action, category, status, dates and archived', () => {
    const rows = [
      row({ id: '1', action: 'admin_created', category: 'security', by: 'a@x.com', details: 'Ali added', atMs: 1000 }),
      row({ id: '2', action: 'key_verify', category: 'license', by: 'b@x.com', status: 'failure', atMs: 2000 }),
      row({ id: '3', action: 'settings_updated', category: 'settings', by: 'a@x.com', archived: true, atMs: 3000 }),
      row({ id: '4', action: 'invoice_created', category: 'financial', by: 'b@x.com', atMs: null })
    ]
    const ids = (f: Partial<typeof EMPTY_FILTERS>) => filterAuditRows(rows, { ...EMPTY_FILTERS, ...f }).map((r) => r.id)
    expect(ids({})).toEqual(['1', '2', '4'])
    expect(ids({ showArchived: true })).toEqual(['1', '2', '3', '4'])
    expect(ids({ search: 'ALI' })).toEqual(['1'])
    expect(ids({ search: 'key verify' })).toEqual(['2'])
    expect(ids({ by: 'a@x.com', showArchived: true })).toEqual(['1', '3'])
    expect(ids({ action: 'key_verify' })).toEqual(['2'])
    expect(ids({ category: 'financial' })).toEqual(['4'])
    expect(ids({ status: 'failure' })).toEqual(['2'])
    expect(ids({ fromMs: 1500, toMs: 2500 })).toEqual(['2'])
    expect(distinctValues(rows, 'by')).toEqual(['a@x.com', 'b@x.com'])
  })

  it('builds an Excel-friendly, injection-safe CSV', () => {
    expect(csvCell('plain')).toBe('plain')
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell('say "hi"')).toBe('"say ""hi"""')
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"')
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`)
    expect(csvCell('+92 300')).toBe("'+92 300")
    expect(csvCell(null)).toBe('')
    expect(csvCell({ a: 1 })).toBe('"{""a"":1}"')

    const csv = auditCsv([row({ id: 'z', action: 'admin_created', details: 'Ali, Sales', atMs: Date.UTC(2026, 9, 15, 8, 30), meta: { uid: 'u1' } })])
    expect(csv.startsWith('﻿')).toBe(true)
    const lines = csv.slice(1).trim().split('\r\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toBe(AUDIT_CSV_COLUMNS.join(','))
    expect(lines[1]).toContain('2026-10-15T08:30:00.000Z,admin_created,license,success,owner@x.com')
    expect(lines[1]).toContain('"Ali, Sales"')
    expect(lines[1]).toContain('"{""uid"":""u1""}"')
    expect(lines[1].endsWith(',no,"{""uid"":""u1""}",z')).toBe(true)
  })

  it('retention: only unprotected entries older than 90 days', () => {
    const now = Date.UTC(2026, 9, 15)
    const old = now - (RETENTION_DAYS + 1) * DAY
    expect(isRetentionDeletable({ category: 'general', atMs: old }, now)).toBe(true)
    expect(isRetentionDeletable({ category: 'settings', atMs: old }, now)).toBe(true)
    expect(isRetentionDeletable({ category: 'support', atMs: old }, now)).toBe(true)
    for (const c of ['security', 'financial', 'license'] as const) expect(isRetentionDeletable({ category: c, atMs: old }, now)).toBe(false)
    expect(isRetentionDeletable({ category: 'general', atMs: now - 89 * DAY }, now)).toBe(false)
    // just over 90 days is still inside the 1 h safety margin used against clock skew
    expect(isRetentionDeletable({ category: 'general', atMs: now - RETENTION_DAYS * DAY - 60_000 }, now)).toBe(false)
    expect(isRetentionDeletable({ category: 'general', atMs: null }, now)).toBe(false)
    // legacy entries count as license entries → kept
    expect(isRetentionDeletable(auditRowFromData('l', { action: 'x', at: { toMillis: () => old } }), now)).toBe(false)
    expect(retentionCutoff(now)).toBe(now - 90 * DAY - 3_600_000)
  })

  it('chunks and parses day boundaries', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunk([], 3)).toEqual([])
    const start = dayStartMs('2026-10-15')!
    expect(new Date(start).getHours()).toBe(0)
    expect(dayEndMs('2026-10-15')! - start).toBe(DAY - 1)
    expect(dayStartMs('15/10/2026')).toBeNull()
  })
})

/* ------------------------------------------------ branding ------------------------------------------------ */

describe('branding settings', () => {
  const png = (chars: number) => `data:image/png;base64,${'A'.repeat(chars)}`

  it('falls back to DEFAULT_BRANDING for missing / mistyped fields', () => {
    expect(normaliseBranding(null)).toEqual(DEFAULT_BRANDING)
    const b = normaliseBranding({ companyName: 'DT', taxRate: '5', poweredByDefault: 'yes', logo: 'http://x/logo.png', customerPrivacy: 'all', extra: 1 })
    expect(b.companyName).toBe('DT')
    expect(b.taxRate).toBe(DEFAULT_BRANDING.taxRate)
    expect(b.poweredByDefault).toBe(DEFAULT_BRANDING.poweredByDefault)
    expect(b.logo).toBeNull()
    expect(b.customerPrivacy).toBe('masked')
    expect('extra' in b).toBe(false)
  })

  it('cleans before saving and publishes only the public subset', () => {
    const c = cleanBranding({ ...DEFAULT_BRANDING, companyName: '  Digital Target ', currency: 'pkr', taxRate: 17.456, verifyBaseUrl: 'https://dt.web.app///' })
    expect(c).toMatchObject({ companyName: 'Digital Target', currency: 'PKR', taxRate: 17.46, verifyBaseUrl: 'https://dt.web.app' })
    expect(Object.keys(publicBranding(c)).sort()).toEqual(['address', 'companyName', 'email', 'logo', 'phone', 'website'])
    expect(changedBrandingFields(DEFAULT_BRANDING, { ...DEFAULT_BRANDING, iban: 'X', logo: png(4) })).toEqual(['logo', 'iban'])
  })

  it('validates fields', () => {
    expect(validateBranding(DEFAULT_BRANDING, 30)).toEqual({})
    const e = validateBranding(
      {
        ...DEFAULT_BRANDING,
        companyName: '',
        email: 'bad',
        currency: 'RUPEES',
        invoicePrefix: 'has space',
        receiptPrefix: '',
        taxRate: 120,
        supportWhatsapp: '+92 345',
        iban: '12',
        verifyBaseUrl: 'dt.web.app',
        mapTileUrl: 'http://tiles/{z}/{x}/{y}.png',
        logo: png(MAX_IMAGE_BYTES)
      },
      2
    )
    expect(Object.keys(e).sort()).toEqual(
      ['companyName', 'currency', 'email', 'iban', 'invoicePrefix', 'logo', 'mapTileUrl', 'receiptPrefix', 'sessionTimeoutMin', 'supportWhatsapp', 'taxRate', 'verifyBaseUrl'].sort()
    )
    expect(validateBranding({ ...DEFAULT_BRANDING, taxRate: Number.NaN }, 30).taxRate).toBeTruthy()
    expect(validateBranding({ ...DEFAULT_BRANDING, mapTileUrl: 'https://tiles.example/{z}/{x}.png' }, 30).mapTileUrl).toMatch(/\{y\}/)
    expect(validateBranding({ ...DEFAULT_BRANDING, mapTileUrl: '' }, 30)).toEqual({})
  })

  it('image size guard keeps each image under ~150 KB', () => {
    expect(imageSizeError(null)).toBeNull()
    expect(imageSizeError(png(1000))).toBeNull()
    expect(imageSizeError(png(MAX_IMAGE_BYTES))).toMatch(/limit/)
    expect(imageSizeError('data:text/html;base64,AAAA')).toMatch(/Unsupported/)
    expect(imageSizeError('data:image/svg+xml;base64,AAAA')).toMatch(/Unsupported/)
    expect(dataUrlBytes('data:image/png;base64,AAAA')).toBe(3)
    expect(dataUrlBytes('data:image/png;base64,AA==')).toBe(1)
    expect(dataUrlStoredBytes(png(10))).toBe(32)
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(150 * 1024)).toBe('150 KB')
    expect(fitWithin(2000, 1000, 512, 512)).toEqual({ width: 512, height: 256 })
    expect(fitWithin(100, 50, 512, 512)).toEqual({ width: 100, height: 50 })
    expect(fitWithin(0, 50, 512, 512)).toEqual({ width: 0, height: 0 })
  })

  it('session timeout and customer name masking', () => {
    expect(clampSessionTimeout(undefined)).toBe(30)
    expect(clampSessionTimeout(1)).toBe(5)
    expect(clampSessionTimeout(10_000)).toBe(480)
    expect(clampSessionTimeout(44.6)).toBe(45)
    expect(maskName('Wetco Solar Traders')).toBe('W**** S**** T******')
    expect(maskName('  A  Bc ')).toBe('A B*')
  })
})

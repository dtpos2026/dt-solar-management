/**
 * Administrator password reset from Digital Target: signed, device-bound, one-time command with only a PBKDF2 verifier of the
 * temporary password. Mirrors what admin-panel/src/lib/passwordReset.ts produces (same domain-separated signature).
 */
import { createPrivateKey, pbkdf2Sync, randomBytes, sign } from 'crypto'
import { describe, expect, it } from 'vitest'
// @ts-expect-error — plain ESM helper without types
import { buildPayload, certificateToCode, generateKeyPair, signPayload } from '../scripts/license-core.mjs'
import { applyResetCommand, getPendingReset, resetState } from '../src/main/services/adminReset'
import { COMMAND_DOMAIN } from '../src/main/license/verify'
import { buildSessionUser, changeOwnPassword, login, loginById } from '../src/main/services/auth'
import { setupCtx, userCtx } from './helpers'
import { buildResetCommand, generateTempPassword, resetProgress } from '../admin-panel/src/lib/resetCommand'
import { loadKey } from '../admin-panel/src/lib/crypto'

const keys = generateKeyPair()
const DEVICE = 'ABCD-1234-EF56-7890-AAAA-BBBB'
const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const TEMP = 'K7MQ-2WXP-9TDH-4RNC'

function command(o: Record<string, unknown> = {}, opts: { pw?: string; privatePem?: string; domain?: string } = {}): string {
  const salt = randomBytes(16)
  const iter = 200_000
  const verifier = pbkdf2Sync((opts.pw ?? TEMP).replace(/-/g, ''), salt, iter, 32, 'sha256')
  const now = Date.now()
  const payload = b64url(
    JSON.stringify({
      v: 1,
      type: 'admin_password_reset',
      licenseId: 'LIC-1',
      deviceId: DEVICE,
      nonce: b64url(randomBytes(16)),
      issuedAt: new Date(now - 1000).toISOString(),
      expiresAt: new Date(now + 3 * 86400000).toISOString(),
      kdf: { alg: 'pbkdf2-sha256', iter, salt: salt.toString('base64') },
      verifier: verifier.toString('base64'),
      ...o
    })
  )
  const signature = b64url(sign(null, Buffer.from((opts.domain ?? COMMAND_DOMAIN) + payload, 'utf8'), createPrivateKey(opts.privatePem ?? keys.privatePem)))
  return `${payload}.${signature}`
}

const ctx = { publicKeyPem: keys.publicPem, deviceId: DEVICE }

describe('Administrator password reset: command verification', () => {
  it('accepts a valid command once and reports progress', () => {
    const { db } = setupCtx()
    const code = command()
    expect(applyResetCommand(db, code, ctx).status).toBe('received')
    expect(getPendingReset(db)).not.toBeNull()
    expect(resetState(db)).toMatch(/:received$/)
    // the online channel offers the same command at every check-in: harmless
    expect(applyResetCommand(db, code, ctx).status).toBe('duplicate')
  })
  it('refuses a command for another computer, an expired one, a tampered one and one signed by another key', () => {
    const { db } = setupCtx()
    expect(applyResetCommand(db, command({ deviceId: 'OTHER-DEVICE-0000-1111' }), ctx)).toMatchObject({ status: 'rejected', message: /different computer/ })
    expect(applyResetCommand(db, command({ expiresAt: new Date(Date.now() - 1000).toISOString() }), ctx)).toMatchObject({ status: 'rejected', message: /expired/ })
    const ok = command()
    const [p, s] = ok.split('.')
    const tampered = `${p.slice(0, -2)}AA.${s}`
    expect(applyResetCommand(db, tampered, ctx).status).toBe('rejected')
    expect(applyResetCommand(db, command({}, { privatePem: generateKeyPair().privatePem }), ctx)).toMatchObject({ status: 'rejected', message: /signature/ })
    expect(applyResetCommand(db, command({ kdf: { alg: 'pbkdf2-sha256', iter: 10, salt: 'AAAA' } }), ctx).status).toBe('rejected')
    expect(applyResetCommand(db, command({ expiresAt: new Date(Date.now() + 30 * 86400000).toISOString() }), ctx).status).toBe('rejected')
    expect(applyResetCommand(db, 'not a code', ctx).status).toBe('rejected')
    expect(getPendingReset(db)).toBeNull()
  })
  it('a license certificate can never be used as a reset command, nor a command as a certificate (domain separation)', () => {
    const { db } = setupCtx()
    const cert = certificateToCode(signPayload(buildPayload({ deviceId: DEVICE, businessName: 'B' }), keys.privatePem))
    expect(applyResetCommand(db, cert, ctx).status).toBe('rejected')
    // a command signed WITHOUT the domain prefix (i.e. a plain certificate-style signature) is refused as well
    expect(applyResetCommand(db, command({}, { domain: '' }), ctx).status).toBe('rejected')
  })
})

describe('Administrator password reset: sign-in with the temporary password', () => {
  it('the owner signs in once with the temporary password, must choose a new one, and the command cannot be replayed', () => {
    const owner = setupCtx()
    const { db } = owner
    const code = command()
    applyResetCommand(db, code, ctx)
    // a wrong password does nothing
    expect(() => login(db, 'admin', 'K7MQ-2WXP-9TDH-4RNX')).toThrow(/Invalid username or password/)
    expect(getPendingReset(db)).not.toBeNull()
    // case and dashes do not matter
    const r = login(db, 'admin', 'k7mq 2wxp-9tdh-4rnc')
    expect(r.user.isOwner).toBe(true)
    expect(r.user.mustChangePassword).toBe(true)
    expect(getPendingReset(db)).toBeNull()
    expect(resetState(db)).toMatch(/:used$/)
    // the temporary password is now an ordinary (scrypt-hashed) password that must be changed; it is not stored in plain text
    const stored = (db.prepare("SELECT password_hash FROM users WHERE username = 'admin'").get() as { password_hash: string }).password_hash
    expect(stored.startsWith('scrypt$')).toBe(true)
    expect(stored).not.toContain('K7MQ')
    expect(JSON.stringify(db.prepare('SELECT key, value FROM settings').all())).not.toMatch(/K7MQ2WXP/)
    // replay of the same command is refused
    expect(applyResetCommand(db, code, ctx).status).toBe('duplicate')
    // the old password no longer works
    expect(() => login(db, 'admin', 'secret123')).toThrow()
    expect(audits(db)).toContain('password_reset')
  })
  it('recovers a locked-out Administrator and works from the user-tile sign-in too', () => {
    const owner = setupCtx()
    const { db } = owner
    for (let i = 0; i < 5; i++) expect(() => login(db, 'admin', 'bad')).toThrow()
    expect(() => login(db, 'admin', 'secret123')).toThrow(/Too many failed attempts/)
    applyResetCommand(db, command(), ctx)
    const id = (db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: number }).id
    expect(loginById(db, id, TEMP).user.mustChangePassword).toBe(true)
  })
  it('only the Administrator (owner) account accepts the temporary password', () => {
    const owner = setupCtx()
    userCtx(owner, 'Accountant', 'clerk')
    applyResetCommand(owner.db, command(), ctx)
    expect(() => login(owner.db, 'clerk', TEMP)).toThrow()
    expect(getPendingReset(owner.db)).not.toBeNull()
  })
  it('an expired pending reset no longer works', () => {
    const owner = setupCtx()
    applyResetCommand(owner.db, command({ issuedAt: new Date(Date.now() - 5 * 86400000).toISOString(), expiresAt: new Date(Date.now() + 1500).toISOString() }), ctx)
    expect(getPendingReset(owner.db, Date.now() + 5000)).toBeNull()
  })
})

describe('Administrator password reset: command built by the Super Admin portal code', () => {
  it('the portal-built command is accepted by the desktop and the generated password signs in (end to end)', async () => {
    const key = await loadKey(keys.privatePem)
    const owner = setupCtx()
    const built = await buildResetCommand({ licenseId: 'LIC-1', deviceId: DEVICE, key })
    expect(built.password).toMatch(/^[A-HJKMNP-Z2-9]{4}(-[A-HJKMNP-Z2-9]{4}){3}$/)
    expect(built.code).not.toContain(built.password.replace(/-/g, ''))
    expect(applyResetCommand(owner.db, built.code, ctx).status).toBe('received')
    expect(resetProgress(resetState(owner.db), built.nonce)).toBe('received')
    expect(login(owner.db, 'admin', built.password.toLowerCase()).user.mustChangePassword).toBe(true)
    // the forced change accepts the temporary password however it is typed (capitals / dashes)
    const me = buildSessionUser(owner.db, (owner.db.prepare("SELECT id FROM users WHERE username = 'admin'").get() as { id: number }).id)
    changeOwnPassword({ db: owner.db, user: me, firmId: owner.firmId }, built.password.toLowerCase().replace(/-/g, ''), 'Brand#New2026pw')
    expect(login(owner.db, 'admin', 'Brand#New2026pw').user.mustChangePassword).toBe(false)
    expect(resetProgress(resetState(owner.db), built.nonce)).toBe('used')
    // every reset has its own random password
    expect(new Set(Array.from({ length: 50 }, () => generateTempPassword())).size).toBe(50)
  })
  it('a command for another computer or signed with another key never works', async () => {
    const owner = setupCtx()
    const key = await loadKey(keys.privatePem)
    const other = await buildResetCommand({ licenseId: 'LIC-1', deviceId: 'SOME-OTHER-DEVICE-1234', key })
    expect(applyResetCommand(owner.db, other.code, ctx).status).toBe('rejected')
    const stranger = await buildResetCommand({ licenseId: 'LIC-1', deviceId: DEVICE, key: await loadKey(generateKeyPair().privatePem) })
    expect(applyResetCommand(owner.db, stranger.code, ctx).status).toBe('rejected')
  })
})

function audits(db: import('../src/main/db').DB): string {
  return (db.prepare("SELECT action FROM audit_log WHERE entity = 'user'").all() as Array<{ action: string }>).map((r) => r.action).join(',')
}

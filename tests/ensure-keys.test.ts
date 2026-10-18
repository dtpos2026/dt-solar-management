/**
 * Build-time key handling (scripts/ensure-keys.mjs): a fresh source folder must end up trusting the signing key(s) of the Super Admin
 * panel without any step from the owner, and a key must never be created while an earlier one exists on the computer.
 */
import { execFileSync } from 'child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { generateKeyPairSync, sign } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { keyMismatchMessage, publicKeyId, publicKeysOf, verifyCertificate, verifyCommand } from '../src/main/license/verify'
import { keyIdOf, keyMismatch } from '../admin-panel/src/lib/keyId'
import { loadKey } from '../admin-panel/src/lib/crypto'

const base = mkdtempSync(join(tmpdir(), 'dtsp-keys-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const pair = () => {
  const k = generateKeyPairSync('ed25519')
  return { priv: k.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), pub: k.publicKey.export({ type: 'spki', format: 'pem' }).toString(), key: k }
}

/** A source folder shaped like the owner's: <tree>/<name>/DT-Solar-Pro with scripts and the placeholder public key. */
function sourceFolder(tree: string, name: string, privateKey?: string): string {
  const root = join(tree, name, 'DT-Solar-Pro')
  mkdirSync(join(root, 'scripts'), { recursive: true })
  mkdirSync(join(root, 'resources'), { recursive: true })
  for (const f of ['ensure-keys.mjs', 'license-core.mjs']) copyFileSync(join(__dirname, '..', 'scripts', f), join(root, 'scripts', f))
  writeFileSync(join(root, 'resources', 'license-public.pem'), 'NOT_CONFIGURED')
  if (privateKey) {
    mkdirSync(join(root, 'keys'), { recursive: true })
    writeFileSync(join(root, 'keys', 'license-private.pem'), privateKey)
  }
  return root
}

function runBuildCheck(root: string, home: string): string {
  return execFileSync('node', [join(root, 'scripts', 'ensure-keys.mjs')], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, 'AppData'), DTSP_KEY_STORE: join(home, 'store') } })
}

const pubBlocks = (root: string): string[] => readFileSync(join(root, 'resources', 'license-public.pem'), 'utf8').match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g) ?? []

describe('ensure-keys: no manual step, no silent new key', () => {
  it('a new source folder finds the keys of the earlier folders next to it and trusts all of them', () => {
    const tree = join(base, 'A', 'DT Solar Management')
    const home = join(base, 'A', 'home')
    mkdirSync(home, { recursive: true })
    const k1 = pair()
    const k2 = pair()
    sourceFolder(tree, 'DT-Solar-Pro-v1.1-source', k1.priv)
    sourceFolder(tree, 'DT-Solar-Pro-v1.4-source', k2.priv)
    const fresh = sourceFolder(tree, 'DT-Solar-Pro-v1.5-restore-fix-source')
    const out = runBuildCheck(fresh, home)
    expect(out).toContain('trusts 2 license signing keys')
    expect(out).not.toContain('NEW LICENSE SIGNING KEY')
    expect(existsSync(join(fresh, 'keys', 'license-private.pem'))).toBe(false) // no key is created or copied
    const blocks = pubBlocks(fresh)
    expect(blocks).toHaveLength(2)
    const ids = new Set(blocks.map((b) => publicKeyId(b)))
    expect(ids).toEqual(new Set([publicKeyId(k1.pub), publicKeyId(k2.pub)]))
    // the private keys never end up in the file the installer carries
    expect(readFileSync(join(fresh, 'resources', 'license-public.pem'), 'utf8')).not.toContain('PRIVATE')
  })

  it('creates a key only when none exists anywhere, keeps it per user, and the next folder reuses it', () => {
    const tree = join(base, 'B', 'tree')
    const home = join(base, 'B', 'home')
    mkdirSync(home, { recursive: true })
    const first = sourceFolder(tree, 'first')
    const out1 = runBuildCheck(first, home)
    expect(out1).toContain('A NEW LICENSE SIGNING KEY WAS CREATED')
    expect(existsSync(join(first, 'keys', 'license-private.pem'))).toBe(true)
    expect(existsSync(join(home, 'store', 'license-private.pem'))).toBe(true)
    expect(pubBlocks(first)).toHaveLength(1)
    // a brand new folder somewhere else on the same computer: same key, nothing created
    const second = sourceFolder(join(base, 'B', 'elsewhere'), 'second')
    const out2 = runBuildCheck(second, home)
    expect(out2).not.toContain('NEW LICENSE SIGNING KEY')
    expect(publicKeyId(pubBlocks(second)[0])).toBe(publicKeyId(pubBlocks(first)[0]))
    // running it again changes nothing
    const before = readFileSync(join(second, 'resources', 'license-public.pem'), 'utf8')
    runBuildCheck(second, home)
    expect(readFileSync(join(second, 'resources', 'license-public.pem'), 'utf8')).toBe(before)
  })

  it('a public key pasted from the panel is kept next to the discovered ones', () => {
    const tree = join(base, 'C', 'tree')
    const home = join(base, 'C', 'home')
    mkdirSync(home, { recursive: true })
    const old = pair()
    const panel = pair()
    sourceFolder(tree, 'old', old.priv)
    const fresh = sourceFolder(tree, 'fresh')
    writeFileSync(join(fresh, 'resources', 'license-public.pem'), panel.pub)
    runBuildCheck(fresh, home)
    expect(new Set(pubBlocks(fresh).map(publicKeyId))).toEqual(new Set([publicKeyId(old.pub), publicKeyId(panel.pub)]))
  })
})

describe('an installer that trusts several keys', () => {
  const b64url = (b: Buffer | string): string => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  const cert = (privPem: string) => {
    const payload = b64url(JSON.stringify({ v: 1, licenseId: 'L', deviceId: 'DEV-1', businessName: 'X', issuedAt: new Date().toISOString(), expiresAt: null, maxDevices: 1 }))
    return { format: 'dtsp-license' as const, payload, signature: b64url(sign(null, Buffer.from(payload, 'utf8'), privPem)) }
  }

  it('verifies a certificate signed by any trusted key and refuses an untrusted one', () => {
    const a = pair()
    const b = pair()
    const other = pair()
    const both = a.pub + b.pub
    expect(publicKeysOf(both)).toHaveLength(2)
    expect(verifyCertificate(cert(a.priv) as never, both, 'DEV-1').ok).toBe(true)
    expect(verifyCertificate(cert(b.priv) as never, both, 'DEV-1').ok).toBe(true)
    expect(verifyCertificate(cert(b.priv) as never, a.pub, 'DEV-1').ok).toBe(false)
    expect(verifyCertificate(cert(other.priv) as never, both, 'DEV-1')).toMatchObject({ ok: false, reason: expect.stringMatching(/signature is invalid/) })
    expect(verifyCommand({ format: 'dtsp-command', payload: 'x', signature: 'y' } as never, both).ok).toBe(false)
    // key IDs: one per trusted key, comma separated, single key unchanged
    expect(publicKeyId(both).split(',')).toHaveLength(2)
    expect(publicKeyId(a.pub)).toMatch(/^[0-9A-F]{16}$/)
    expect(keyMismatchMessage(other.pub)).toContain(publicKeyId(other.pub))
  })

  it('the panel recognises the installer when its loaded key is any of the installer keys', async () => {
    const a = pair()
    const b = pair()
    const loadedB = await loadKey(b.priv)
    const ids = publicKeyId(a.pub + b.pub)
    expect(keyMismatch(ids, loadedB.fingerprint)).toBe(false)
    expect(keyMismatch(publicKeyId(a.pub), loadedB.fingerprint)).toBe(true)
    expect(keyIdOf(loadedB.fingerprint)).toBe(publicKeyId(b.pub))
  })
})

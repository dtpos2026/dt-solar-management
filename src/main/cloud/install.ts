/**
 * Installation token: 40 random characters [A-Za-z0-9], generated once per installation and kept in the license
 * folder (install.json). It is the secret id of heartbeats/{token} and supportThreads/{token} in Firestore, so it is
 * never logged and never shown in full (see maskToken).
 */
import { randomBytes } from 'crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { join } from 'path'

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
export const TOKEN_RE = /^[A-Za-z0-9]{40}$/

/** Unbiased random string from [A-Za-z0-9] (rejection sampling, no modulo bias). */
export function randomToken(len = 40): string {
  let out = ''
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < 248) out += ALPHABET[b % 62] // 248 = 4 * 62
      if (out.length === len) break
    }
  }
  return out
}

export function maskToken(token: string): string {
  if (!token) return ''
  return `${token.slice(0, 4)}…${token.slice(-4)}`
}

/** Reads the installation token, creating it once when missing or malformed. */
export function loadInstallToken(dir: string): { token: string; createdAt: string } {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'install.json')
  if (existsSync(file)) {
    try {
      const j = JSON.parse(readFileSync(file, 'utf8')) as { token?: string; createdAt?: string }
      if (j.token && TOKEN_RE.test(j.token)) return { token: j.token, createdAt: j.createdAt ?? '' }
    } catch {
      /* rewritten below */
    }
  }
  const rec = { token: randomToken(40), createdAt: new Date().toISOString() }
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(rec, null, 2), { mode: 0o600 })
  renameSync(tmp, file)
  return rec
}

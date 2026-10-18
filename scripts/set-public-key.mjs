/**
 * Puts the Super Admin panel's public signing key into this build (resources/license-public.pem).
 *
 *   1. In the Super Admin panel: Settings -> Signing key -> "Copy public key" (the key must be loaded there).
 *   2. npm run license:setpub                (reads the clipboard)
 *      npm run license:setpub -- key.pem     (or reads a file)
 *      npm run license:keyid                 (only shows the Key ID this build carries)
 *   3. npm run dist
 *
 * It only accepts a PUBLIC Ed25519 key, refuses a private key, and prints the Key ID: the Settings -> License and About page of
 * the installed app and the Settings -> Signing key page of the panel must show the same ID.
 */
import { createHash, createPrivateKey, createPublicKey } from 'crypto'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PUB = join(root, 'resources', 'license-public.pem')
const PRIV = join(root, 'keys', 'license-private.pem')

const keyId = (pem) => createHash('sha256').update(createPublicKey(pem).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16).toUpperCase()
const fail = (m) => {
  console.error('\n' + m + '\n')
  process.exit(1)
}

if (process.argv.includes('--show')) {
  const pem = existsSync(PUB) ? readFileSync(PUB, 'utf8') : ''
  if (!pem.includes('BEGIN PUBLIC KEY')) fail('This build has no license public key yet (resources\\license-public.pem is NOT_CONFIGURED). Run: npm run license:setpub')
  console.log(`License key ID of this build: ${keyId(pem)}`)
  process.exit(0)
}

function readClipboard() {
  try {
    if (process.platform === 'win32') return execFileSync('powershell', ['-NoProfile', '-Command', 'Get-Clipboard -Raw'], { encoding: 'utf8' })
    if (process.platform === 'darwin') return execFileSync('pbpaste', { encoding: 'utf8' })
    return execFileSync('xclip', ['-selection', 'clipboard', '-o'], { encoding: 'utf8' })
  } catch {
    return ''
  }
}

const file = process.argv.slice(2).find((a) => !a.startsWith('--'))
const text = (file ? (existsSync(file) ? readFileSync(file, 'utf8') : '') : readClipboard()).trim()
if (!text) fail(file ? `Cannot read ${file}.` : 'The clipboard is empty. In the Super Admin panel open Settings -> Signing key and press "Copy public key", then run this again.')
if (text.includes('PRIVATE KEY')) fail('That is a PRIVATE key. Never paste it here. Use "Copy public key" in the Super Admin panel.')
if (!text.includes('BEGIN PUBLIC KEY')) fail('That is not a public key (it must start with -----BEGIN PUBLIC KEY-----). Use "Copy public key" in the Super Admin panel.')
let pem
try {
  const k = createPublicKey(text)
  if (k.asymmetricKeyType !== 'ed25519') fail('This must be an Ed25519 public key (the one the Super Admin panel shows).')
  pem = k.export({ type: 'spki', format: 'pem' }).toString()
} catch {
  fail('The public key text is damaged. Copy it again from the Super Admin panel.')
}
if (existsSync(PRIV)) {
  const mine = createPublicKey(createPrivateKey(readFileSync(PRIV, 'utf8'))).export({ type: 'spki', format: 'pem' }).toString().replace(/\s/g, '')
  if (mine !== pem.replace(/\s/g, '')) fail('keys\\license-private.pem in this folder belongs to a DIFFERENT key than the one you pasted. Delete or move that file if the pasted public key is the right one.')
}
writeFileSync(PUB, pem)
console.log(`\nPublic key saved to resources\\license-public.pem\nLicense key ID of this build: ${keyId(pem)}\nIt must equal the Key ID shown in the Super Admin panel (Settings -> Signing key). Now run: npm run dist\n`)

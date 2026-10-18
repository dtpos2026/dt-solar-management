/**
 * Runs automatically before `npm run build`. Decides which license public key(s) the installer trusts.
 *
 * The problem this solves: the private signing key (keys\license-private.pem) is never committed, and every freshly unzipped source
 * folder used to create a NEW key, so the installer's public key no longer matched the key loaded in the Super Admin panel
 * ("License signature is invalid", activations that stay pending). Now, without any step from the owner:
 *   1. keys\license-private.pem of this folder, if present, is trusted;
 *   2. the per-user key store (%APPDATA%\DT Solar Pro Signing\) is trusted;
 *   3. signing keys left by EARLIER source folders on this computer (keys\license-private.pem next to this folder, in its parent
 *      and in Downloads / Desktop / Documents) are found and trusted too, so whichever of the owner's keys the panel uses works;
 *   4. a public key already in resources\license-public.pem (for example pasted with `npm run license:setpub`) is kept;
 *   5. only when none exists anywhere a new pair is created (once), kept in the per-user store and in keys\, and the owner is told
 *      to load it in the Super Admin panel.
 * resources\license-public.pem then holds every trusted PUBLIC key. Private keys are never copied into the installer.
 */
import { createHash, createPrivateKey, createPublicKey } from 'crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { generateKeyPair } from './license-core.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRIV = join(root, 'keys', 'license-private.pem')
const PUB = join(root, 'resources', 'license-public.pem')
const STORE_DIR = process.env.DTSP_KEY_STORE || join(process.env.APPDATA || join(homedir(), '.config'), 'DT Solar Pro Signing')
const STORE = join(STORE_DIR, 'license-private.pem')
const PEM_BLOCK = /-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/g

const spki = (pub) => pub.export({ type: 'spki', format: 'pem' }).toString()
const idOf = (pem) => createHash('sha256').update(createPublicKey(pem).export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16).toUpperCase()
const norm = (pem) => pem.replace(/\s/g, '')

/** public key (PEM) of a private key file, or null */
function publicOfPrivateFile(file) {
  try {
    return spki(createPublicKey(createPrivateKey(readFileSync(file, 'utf8'))))
  } catch {
    return null
  }
}

/** keys\license-private.pem files left by earlier source folders (bounded search, no node_modules). */
function discoverPrivateKeyFiles() {
  const found = []
  const skip = new Set(['node_modules', '.git', 'out', 'dist', 'release', '.claude', '$RECYCLE.BIN', 'System Volume Information'])
  const bases = new Set([dirname(root), dirname(dirname(root))])
  for (const d of ['Downloads', 'Desktop', 'Documents']) bases.add(join(homedir(), d))
  let visited = 0
  const walk = (dir, depth) => {
    if (depth > 4 || visited++ > 6000) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (!e.isDirectory() || skip.has(e.name)) continue
      const p = join(dir, e.name)
      if (e.name === 'keys') {
        const f = join(p, 'license-private.pem')
        if (existsSync(f)) found.push(f)
        continue
      }
      walk(p, depth + 1)
    }
  }
  for (const b of bases) if (existsSync(b)) walk(b, 0)
  return found
}

const trusted = new Map() // norm(pem) -> { pem, from }
const trust = (pem, from) => {
  if (pem && !trusted.has(norm(pem))) trusted.set(norm(pem), { pem, from })
}

// 1. this folder's private key, 2. the per-user store
for (const [file, from] of [[PRIV, 'keys\\license-private.pem of this folder'], [STORE, 'the per-user key store']]) {
  if (existsSync(file)) trust(publicOfPrivateFile(file), from)
}
// 4. a public key already configured in this folder
if (existsSync(PUB)) for (const block of readFileSync(PUB, 'utf8').match(PEM_BLOCK) ?? []) {
  try {
    trust(spki(createPublicKey(block)), 'resources\\license-public.pem')
  } catch {
    /* damaged block: dropped */
  }
}
// 3. keys of earlier source folders on this computer (newest first)
const earlier = discoverPrivateKeyFiles()
  .filter((f) => f !== PRIV && f !== STORE)
  .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
for (const f of earlier) trust(publicOfPrivateFile(f), `earlier source folder: ${dirname(dirname(f))}`)

let created = false
if (trusted.size === 0) {
  // 5. nothing anywhere: create the key once
  const { privatePem, publicPem } = generateKeyPair()
  for (const dir of [dirname(PRIV), STORE_DIR]) {
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'license-private.pem'), privatePem)
    } catch {
      /* the other copy remains */
    }
  }
  trust(publicPem, 'NEW key')
  created = true
}

const list = [...trusted.values()]
const text = list.map((k) => k.pem.trim()).join('\n') + '\n'
if (!existsSync(PUB) || norm(readFileSync(PUB, 'utf8')) !== norm(text)) writeFileSync(PUB, text)

console.log(`[license] This installer trusts ${list.length} license signing key${list.length === 1 ? '' : 's'}:`)
for (const k of list) console.log(`   Key ID ${idOf(k.pem)}  (${k.from})`)
if (created) {
  console.log('\n==================================================================')
  console.log(' A NEW LICENSE SIGNING KEY WAS CREATED (none existed on this computer).')
  console.log(' Load keys\\license-private.pem in the Super Admin panel -> Settings ->')
  console.log(' Signing key, and BACK IT UP on a USB drive. Never share it.')
  console.log(` A copy is kept in ${STORE_DIR}`)
  console.log('==================================================================\n')
} else {
  console.log('[license] The Super Admin panel works with any of these keys (its Settings -> Signing key page shows the Key ID).')
}

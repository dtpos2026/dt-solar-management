/**
 * Runs automatically before `npm run build`.
 * Makes sure a license signing key pair exists — creates it ONCE, never overwrites an existing key.
 */
import { createPrivateKey, createPublicKey } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { generateKeyPair } from './license-core.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRIV = join(root, 'keys', 'license-private.pem')
const PUB = join(root, 'resources', 'license-public.pem')
const pubConfigured = existsSync(PUB) && readFileSync(PUB, 'utf8').includes('BEGIN PUBLIC KEY')

if (existsSync(PRIV)) {
  const derived = createPublicKey(createPrivateKey(readFileSync(PRIV, 'utf8'))).export({ type: 'spki', format: 'pem' }).toString()
  if (!pubConfigured || readFileSync(PUB, 'utf8').replace(/\s/g, '') !== derived.replace(/\s/g, '')) {
    writeFileSync(PUB, derived)
    console.log('[license] Public key updated from keys/license-private.pem')
  } else console.log('[license] Signing key OK (keys/license-private.pem)')
} else if (pubConfigured) {
  console.log('[license] Public key present (private key is kept elsewhere) — OK')
} else if (process.env.DTSP_NEW_KEY !== '1') {
  // A fresh checkout / unzip has neither the private key (never committed) nor a configured public key. Creating a new pair here
  // silently produced installers whose public key differs from the key loaded in the Super Admin panel: every activation pass and
  // certificate then fails with "License signature is invalid" and activations stay pending forever. Stop and say what to do.
  console.error('\n==================================================================')
  console.error(' NO LICENSE SIGNING KEY IN THIS FOLDER - BUILD STOPPED')
  console.error('')
  console.error(' Installers must carry the public key of the key loaded in the Super Admin panel.')
  console.error(' Do ONE of these:')
  console.error('  1. Copy your existing keys\\license-private.pem into this folder (keys\\), then build again.')
  console.error('  2. Super Admin -> Settings -> Signing key -> press "Copy public key", then run:')
  console.error('         npm run license:setpub')
  console.error('     (it puts the copied public key into resources\\license-public.pem), then build again.')
  console.error('  3. Only if you have NEVER issued a license and want a brand new key:')
  console.error('     set DTSP_NEW_KEY=1 for this build (then load keys\\license-private.pem in the panel).')
  console.error('==================================================================\n')
  process.exit(1)
} else {
  const { privatePem, publicPem } = generateKeyPair()
  mkdirSync(dirname(PRIV), { recursive: true })
  writeFileSync(PRIV, privatePem)
  writeFileSync(PUB, publicPem)
  console.log('\n==================================================================')
  console.log(' NEW LICENSE SIGNING KEY CREATED: keys\\license-private.pem')
  console.log(' - Load this file in the Super Admin panel -> "Signing key".')
  console.log(' - BACK IT UP on a USB drive. Never share it. If it is lost,')
  console.log('   you cannot issue licenses for this build any more.')
  console.log('==================================================================\n')
}

#!/usr/bin/env node
/**
 * DT Solar Pro license tool (Digital Target only).
 *   node scripts/license-tool.mjs keygen [--force]
 *   node scripts/license-tool.mjs issue --request <code> --business "Name" [--customer "Name"] [--phone] [--email]
 *        [--plan professional] [--firms 5] [--users 10] [--days 365 | --lifetime] [--checkin 0] [--grace 15] [--out file.dtlic]
 *   node scripts/license-tool.mjs verify <file.dtlic | code> [--device <id>]
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'
import { createPublicKey, verify } from 'crypto'
import { b64urlDecode, buildPayload, certificateToCode, decodeRequestCode, generateKeyPair, signPayload } from './license-core.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const PRIV = join(root, 'keys', 'license-private.pem')
const PUB = join(root, 'resources', 'license-public.pem')
const [cmd, ...rest] = process.argv.slice(2)
const args = {}
const positional = []
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) {
    const k = rest[i].slice(2)
    const v = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true
    args[k] = v
  } else positional.push(rest[i])
}

function keygen() {
  if (existsSync(PRIV) && !args.force) {
    console.error(`A private key already exists at ${PRIV}. Use --force only if you really want a NEW key (old licenses will stop verifying in new builds).`)
    process.exit(1)
  }
  const { privatePem, publicPem } = generateKeyPair()
  mkdirSync(dirname(PRIV), { recursive: true })
  writeFileSync(PRIV, privatePem)
  try { chmodSync(PRIV, 0o600) } catch { /* windows */ }
  writeFileSync(PUB, publicPem)
  console.log(`\n✔ Private key: ${PRIV}  (KEEP SECRET — back it up on a USB drive. Never share or commit it.)`)
  console.log(`✔ Public key : ${PUB}  (built into the app)\n`)
  console.log('Next steps:\n  1. npm run dist:win   (rebuild the installer so it contains the new public key)')
  console.log('  2. In the Super Admin panel open "Signing key" and load keys/license-private.pem')
  console.log('  3. Issue licenses from the admin panel, or offline with: npm run license:issue -- --request <code> --business "Name"\n')
}

function issue() {
  if (!existsSync(PRIV)) throw new Error('No private key. Run: npm run license:keygen')
  if (!args.request) throw new Error('--request <code> is required (copy it from the customer\'s License page).')
  if (!args.business) throw new Error('--business "Business name" is required.')
  const req = decodeRequestCode(args.request)
  const days = args.lifetime ? null : Number(args.days ?? 365)
  const payload = buildPayload({
    deviceId: req.deviceId,
    businessName: args.business,
    customerName: args.customer,
    phone: args.phone,
    email: args.email,
    plan: args.plan,
    maxFirms: args.firms,
    maxUsers: args.users,
    expiresAt: days ? new Date(Date.now() + days * 86400000).toISOString() : null,
    checkinDays: args.checkin ?? 0,
    graceDays: args.grace ?? 15,
    licenseId: args['license-id']
  })
  const cert = signPayload(payload, readFileSync(PRIV, 'utf8'))
  const out = args.out || join(root, `${String(args.business).replace(/[^\w-]+/g, '_')}-${req.deviceId.slice(0, 9)}.dtlic`)
  writeFileSync(out, JSON.stringify(cert, null, 2))
  console.log(`\n✔ License for ${payload.businessName} (device ${req.deviceId} — ${req.deviceName ?? ''})`)
  console.log(`  Expires: ${payload.expiresAt ?? 'Lifetime'} · Firms ${payload.maxFirms} · Users ${payload.maxUsers}`)
  console.log(`  File: ${out}\n\nActivation code (customer can paste this on the License page):\n${certificateToCode(cert)}\n`)
}

function verifyCmd() {
  const input = positional[0]
  if (!input) throw new Error('Give a .dtlic file or an activation code.')
  const text = existsSync(input) ? readFileSync(input, 'utf8') : input
  const cert = text.trim().startsWith('{') ? JSON.parse(text) : { payload: text.split('.')[0], signature: text.split('.')[1] }
  const ok = verify(null, Buffer.from(cert.payload, 'utf8'), createPublicKey(readFileSync(PUB, 'utf8')), b64urlDecode(cert.signature))
  const payload = JSON.parse(b64urlDecode(cert.payload).toString('utf8'))
  console.log(ok ? '✔ Signature valid' : '✖ Signature INVALID')
  if (args.device && args.device !== payload.deviceId) console.log('✖ Device does not match')
  console.log(payload)
}

try {
  if (cmd === 'keygen') keygen()
  else if (cmd === 'issue') issue()
  else if (cmd === 'verify') verifyCmd()
  else console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 8).join('\n'))
} catch (e) {
  console.error(`Error: ${e.message}`)
  process.exit(1)
}

/**
 * License service for the desktop app.
 *
 * Offline policy (see docs/LICENSING.md):
 *  - A license is a certificate signed (Ed25519) by Digital Target. The app only holds the PUBLIC key.
 *  - The certificate is bound to this computer's device id and carries limits (firms, users), expiry and
 *    an optional "lease" date before which the app must check in online. After the lease, a grace period applies.
 *  - No signing server is needed (works on Firebase's free Spark plan): online activation creates an
 *    "activation request" document in Firestore (with the customer's registration details); Digital Target's Super
 *    Admin panel signs the certificate (private key stays on the admin's computer) and writes it back; the app picks
 *    it up and installs it.
 *  - Check-ins read licenseStatus/{licenseId} from Firestore whenever internet is available. Suspension /
 *    revocation / device deactivation take effect at the next successful check-in, or when the check-in
 *    interval + grace period runs out on a computer that stays offline. Re-signed certificates published in
 *    licenseStatus.certs[deviceId] (renewal, plan / limit change, lifetime detachment) are installed at check-in.
 *  - A detached lifetime license performs no license check-ins at all (heartbeats continue).
 *  - A license problem NEVER deletes or modifies business data. At worst the app becomes read-only
 *    (view, print, export and backup still work).
 *  - There is NO local trial (v1.2): without a certificate the app is "not activated" (read-only). A trial is a
 *    certificate issued by the Super Admin with plan 'trial' and a short expiry.
 *  - Enforcement: background check at start-up, at sign-in (non-blocking) and before protected writes (router) when the
 *    last successful verification is older than 5 minutes (<= 4 s wait, concurrent checks share one request). A remote
 *    block (suspended / revoked / expired / this device deactivated) is persisted in the license folder AND in the business
 *    DB (settings.license_remote); network failures never clear it. A computer that stays offline can only be blocked
 *    when its check-in deadline + grace period runs out.
 */
import { createHash, randomBytes } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { hostname, networkInterfaces, platform, release } from 'os'
import { join } from 'path'
import type { ActivationNotice, ActivationResult, LicenseCertificate, LicensePayload, LicenseStatus, Registration, RemoteBlock, RemoteRecord } from './types'
import { TRIAL_LIMITS } from './types'
import { PASS_DEVICE, WRITE_MODES, blockReasonOf, evaluate, parseCertificate, verifyCertificate } from './verify'
import { AppError } from '../services/context'
import { FirestoreError, FirestoreRest, resolveFirestoreConfig, type FirestoreConfig, type RestOptions, type Write } from '../cloud/firestore'
import { loadInstallToken, maskToken } from '../cloud/install'
import { decideCertUpdate, isDetached } from '../cloud/certRefresh'
import { log as appLog } from '../log'

interface State {
  /** Legacy (v1.0/v1.1 local trial). Never created any more; kept when present so old installations are recognised. */
  trialStartedAt?: number
  lastSeenAt: number
  remoteStatus: string | null
  /** License the remote decision belongs to, and when this computer learned about it (v1.2). */
  remoteLicenseId?: string | null
  remoteAt?: string | null
  lastCheckAt: string | null
  lastCheckError: string | null
  pendingRequest: { id: string; licenseKey: string; createdAt: string; reason?: string } | null
  /** Activation pass this computer registered with online (instant activation); only then is the pass valid here. */
  boundPass?: { licenseId: string; deviceId: string } | null
  /** Latest "Powered by Digital Target" flag published by the Super Admin (overrides the certificate). */
  remotePoweredBy?: boolean | null
  /** v1.1 */
  registration?: Registration | null
  certUpdate?: { at: string; summary: string } | null
  activationNotice?: ActivationNotice | null
  /** Key of the request that activated this computer (re-entering it must not create a second approval). */
  activatedKey?: string | null
}

function readMachineId(): string {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5000
      })
      const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i)
      if (m) return m[1]
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 })
      const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)
      if (m) return m[1]
    } else {
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (existsSync(f)) return readFileSync(f, 'utf8').trim()
      }
    }
  } catch {
    /* fall through */
  }
  const macs = Object.values(networkInterfaces())
    .flat()
    .filter((n) => n && !n.internal && n.mac && n.mac !== '00:00:00:00:00:00')
    .map((n) => n!.mac)
    .sort()
  return `${hostname()}|${macs[0] ?? 'nomac'}`
}

export function computeDeviceId(machineId = readMachineId()): string {
  const h = createHash('sha256').update(`dt-solar-pro|${machineId}`).digest('hex').slice(0, 24).toUpperCase()
  return h.match(/.{1,4}/g)!.join('-')
}

function b64url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export const LICENSE_KEY_RE = /^DTSP(-[A-Z0-9]{4}){4}$/

/** Validates the registration details collected with an online activation. */
export function cleanRegistration(r: unknown): Registration {
  const o = (r ?? {}) as Record<string, unknown>
  const text = (v: unknown, label: string, max: number, required: boolean): string => {
    const s = typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : ''
    if (required && !s) throw new AppError(`${label} is required.`, 'VALIDATION')
    if (s.length > max) throw new AppError(`${label} is too long (max ${max} characters).`, 'VALIDATION')
    return s
  }
  const phone = text(o.phone, 'Phone', 60, true)
  if (!/^[+\d][\d\s()./-]{5,}$/.test(phone) || (phone.match(/\d/g)?.length ?? 0) < 7) throw new AppError('Enter a valid phone number (at least 7 digits).', 'VALIDATION')
  return {
    companyName: text(o.companyName, 'Company name', 200, true),
    ownerName: text(o.ownerName, 'Owner name', 200, true),
    phone,
    address: text(o.address, 'Address', 300, false)
  }
}

/**
 * activationRequests/{id} create through documents:commit: `createdAt` is the server's request time (customer clocks
 * can be wrong) and the precondition makes it a pure create (rules: create only, status 'pending').
 */
export function activationRequestWrite(id: string, fields: Record<string, unknown>): Write {
  return { path: `activationRequests/${id}`, fields, serverTime: ['createdAt'], exists: false }
}

/** A successful verification is trusted for this long before a protected write checks again. */
export const FRESH_MS = 5 * 60_000
/** After a failed (network) check, writes do not wait for another check for this long. */
export const RETRY_AFTER_FAILURE_MS = 60_000
/** Longest a protected write waits for a check-in. */
export const WRITE_CHECK_WAIT_MS = 4_000

const REMOTE_BLOCKS: RemoteBlock[] = ['suspended', 'revoked', 'deactivated']
const SEVERITY: Record<RemoteBlock, number> = { revoked: 3, suspended: 2, deactivated: 1 }
const isRemoteBlock = (v: unknown): v is RemoteBlock => typeof v === 'string' && (REMOTE_BLOCKS as string[]).includes(v)

/** Validates a remote record read from the business DB. */
export function cleanRemoteRecord(v: unknown): RemoteRecord | null {
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  if (!o || typeof o.licenseId !== 'string' || !o.licenseId || !isRemoteBlock(o.status)) return null
  return { licenseId: o.licenseId, status: o.status, at: typeof o.at === 'string' && Number.isFinite(Date.parse(o.at)) ? o.at : new Date(0).toISOString() }
}

/**
 * The remote decision in a licenseStatus document for this device (null = no block). Expiry is not taken from here:
 * the signed certificate's expiresAt decides (renewals arrive as re-signed certificates). Exported for tests.
 */
export function remoteDecision(d: Record<string, unknown>, deviceId: string): RemoteBlock | null {
  const status = typeof d.status === 'string' ? d.status : 'active'
  if (status === 'revoked' || status === 'suspended') return status
  const deactivated = Array.isArray(d.deactivatedDevices) ? (d.deactivatedDevices as unknown[]).map(String) : []
  if (deactivated.includes(deviceId)) return 'deactivated'
  return null
}

export interface LicenseServiceOptions {
  dir: string
  publicKeyPem: string
  /** Production Firestore project (overridable for tests with DTSP_FIRESTORE_EMULATOR). null = offline-only build. */
  firestore: { projectId: string; apiKey: string } | null
  appVersion: string
  /**
   * Copy of the remote decision in the business DB (settings.license_remote), so deleting the license folder state does
   * not silently restore access. Optional (tests / no DB).
   */
  getDbRemote?: () => unknown
  setDbRemote?: (r: RemoteRecord | null) => void
  /** True when the business DB shows the former local trial was used (app_meta.trial_started_at). Wording only. */
  hasLegacyTrial?: () => boolean
  /** Tests: clock. */
  now?: () => number
  /** Tests: fixed machine id (device id derivation). */
  machineId?: string
  onChange?: (s: LicenseStatus) => void
  /** Tests: custom fetch / headers / environment. */
  rest?: RestOptions
  env?: Record<string, string | undefined>
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export class LicenseService {
  readonly deviceId: string
  readonly deviceName: string
  /** Secret installation token (heartbeats / support thread id). Never shown in full. */
  readonly installToken: string
  readonly firestoreConfig: FirestoreConfig | null
  readonly client: FirestoreRest | null
  private certFile: string
  private stateFile: string
  private cached: LicenseStatus | null = null
  /** The running check-in (concurrent callers share it). */
  private inflight: Promise<{ status: LicenseStatus; error: AppError | null }> | null = null
  private lastFailureAt = 0

  constructor(private opts: LicenseServiceOptions) {
    mkdirSync(opts.dir, { recursive: true })
    this.certFile = join(opts.dir, 'license.json')
    this.stateFile = join(opts.dir, 'state.json')
    this.deviceId = computeDeviceId(opts.machineId ?? readMachineId())
    this.deviceName = hostname()
    this.installToken = loadInstallToken(opts.dir).token
    this.firestoreConfig = resolveFirestoreConfig(opts.firestore, opts.env ?? process.env)
    this.client = this.firestoreConfig ? new FirestoreRest(this.firestoreConfig, opts.rest) : null
  }

  get os(): string {
    return `${platform()} ${release()}`
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    const fn = this.opts.log ?? appLog
    fn(level, message)
  }

  get appVersion(): string {
    return this.opts.appVersion
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  private readState(): State {
    let s: Partial<State> = {}
    try {
      s = JSON.parse(readFileSync(this.stateFile, 'utf8'))
    } catch {
      s = {}
    }
    const now = this.now()
    return {
      ...(typeof s.trialStartedAt === 'number' && s.trialStartedAt > 0 ? { trialStartedAt: s.trialStartedAt } : {}),
      lastSeenAt: typeof s.lastSeenAt === 'number' ? s.lastSeenAt : now,
      remoteStatus: s.remoteStatus ?? null,
      remoteLicenseId: s.remoteLicenseId ?? null,
      remoteAt: s.remoteAt ?? null,
      lastCheckAt: s.lastCheckAt ?? null,
      lastCheckError: s.lastCheckError ?? null,
      pendingRequest: s.pendingRequest ?? null,
      remotePoweredBy: typeof s.remotePoweredBy === 'boolean' ? s.remotePoweredBy : null,
      registration: s.registration ?? null,
      certUpdate: s.certUpdate ?? null,
      activationNotice: s.activationNotice ?? null,
      activatedKey: s.activatedKey ?? null,
      boundPass: s.boundPass && typeof s.boundPass.licenseId === 'string' ? s.boundPass : null
    }
  }

  /** True when this computer registered the activation pass of `licenseId` online. */
  private passBound(s: State, licenseId: string): boolean {
    return !!s.boundPass && s.boundPass.licenseId === licenseId && s.boundPass.deviceId === this.deviceId
  }

  private readDbRemote(): RemoteRecord | null {
    try {
      return cleanRemoteRecord(this.opts.getDbRemote?.())
    } catch {
      return null
    }
  }

  /**
   * The remote decision that applies to `licenseId`: the most severe of the license-folder state and the business DB
   * copy (either one alone is enough to block). Legacy state (no license id) applies to the installed license.
   */
  private effectiveRemote(s: State, licenseId: string): RemoteRecord | null {
    const recs: RemoteRecord[] = []
    if (isRemoteBlock(s.remoteStatus) && (!s.remoteLicenseId || s.remoteLicenseId === licenseId)) {
      recs.push({ licenseId, status: s.remoteStatus, at: s.remoteAt || s.lastCheckAt || new Date(0).toISOString() })
    }
    const db = this.readDbRemote()
    if (db && db.licenseId === licenseId) recs.push(db)
    if (!recs.length) return null
    recs.sort((a, b) => SEVERITY[b.status] - SEVERITY[a.status] || Date.parse(b.at) - Date.parse(a.at))
    return recs[0]
  }

  /** Records (or clears, with null) the remote decision for `licenseId` in the state AND the business DB. */
  private setRemote(s: State, licenseId: string, status: RemoteBlock | null): void {
    if (status) {
      const prev = this.effectiveRemote(s, licenseId)
      const at = prev && prev.status === status ? prev.at : this.iso()
      s.remoteStatus = status
      s.remoteLicenseId = licenseId
      s.remoteAt = at
      try {
        this.opts.setDbRemote?.({ licenseId, status, at })
      } catch (e) {
        this.log('warn', `Could not store the license decision in the database: ${(e as Error).message}`)
      }
    } else {
      s.remoteStatus = null
      s.remoteLicenseId = null
      s.remoteAt = null
      const db = this.readDbRemote()
      if (db && db.licenseId === licenseId) {
        try {
          this.opts.setDbRemote?.(null)
        } catch (e) {
          this.log('warn', `Could not clear the license decision in the database: ${(e as Error).message}`)
        }
      }
    }
  }

  private writeState(s: State): void {
    const tmp = this.stateFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(s, null, 2))
    renameSync(tmp, this.stateFile)
  }

  private readCert(): LicenseCertificate | null {
    if (!existsSync(this.certFile)) return null
    try {
      return parseCertificate(readFileSync(this.certFile, 'utf8'))
    } catch {
      return null
    }
  }

  private writeCert(cert: LicenseCertificate): void {
    const tmp = this.certFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(cert, null, 2))
    renameSync(tmp, this.certFile)
  }

  get onlineConfigured(): boolean {
    return !!this.client
  }

  get signingConfigured(): boolean {
    return this.opts.publicKeyPem.includes('BEGIN PUBLIC KEY')
  }

  /** Registration details sent with the last online activation (null if none). */
  registration(): Registration | null {
    return this.readState().registration ?? null
  }

  saveRegistration(r: Registration): void {
    const s = this.readState()
    s.registration = r
    this.writeState(s)
  }

  /** Records that the app was used now (clock-rollback protection). */
  touch(): void {
    const s = this.readState()
    const now = this.now()
    if (now > s.lastSeenAt) {
      s.lastSeenAt = now
      this.writeState(s)
    }
  }

  status(refresh = false): LicenseStatus {
    if (this.cached && !refresh) return this.cached
    const s = this.readState()
    const cert = this.readCert()
    let payload: LicensePayload | null = null
    let certError: string | null = null
    if (cert) {
      const r = verifyCertificate(cert, this.opts.publicKeyPem, this.deviceId, (lid) => this.passBound(s, lid))
      if (r.ok) payload = r.payload
      else certError = r.reason
    }
    let legacyTrial = typeof s.trialStartedAt === 'number'
    if (!legacyTrial) {
      try {
        legacyTrial = !!this.opts.hasLegacyTrial?.()
      } catch {
        legacyTrial = false
      }
    }
    const ev = evaluate({
      now: this.now(),
      payload,
      certError,
      legacyTrial,
      lastSeenAt: s.lastSeenAt,
      remoteStatus: payload ? (this.effectiveRemote(s, payload.licenseId)?.status ?? null) : null,
      lastCheckAt: s.lastCheckAt ? Date.parse(s.lastCheckAt) : null
    })
    const detached = isDetached(payload)
    const st: LicenseStatus = {
      mode: ev.mode,
      blockReason: blockReasonOf(ev.mode),
      legacyTrial,
      canWrite: WRITE_MODES.includes(ev.mode),
      message: ev.message,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      payload,
      trialDaysLeft: ev.trialDaysLeft,
      daysLeft: ev.daysLeft,
      graceDaysLeft: ev.graceDaysLeft,
      lastCheckAt: s.lastCheckAt,
      lastCheckError: s.lastCheckError,
      pendingRequestId: s.pendingRequest?.id ?? null,
      pendingReason: s.pendingRequest?.reason ?? null,
      onlineConfigured: this.onlineConfigured,
      signingConfigured: this.signingConfigured,
      maxFirms: payload ? payload.maxFirms : TRIAL_LIMITS.maxFirms,
      maxUsers: payload ? payload.maxUsers : TRIAL_LIMITS.maxUsers,
      // A detached license no longer receives remote settings — its certificate decides.
      poweredBy: detached ? !!payload?.poweredBy : (s.remotePoweredBy ?? payload?.poweredBy ?? false),
      detached,
      registration: s.registration ?? null,
      installId: maskToken(this.installToken),
      certUpdate: s.certUpdate ?? null,
      activationNotice: s.activationNotice ?? null
    }
    const changed = !this.cached || this.cached.mode !== st.mode || this.cached.message !== st.message
    this.cached = st
    if (changed) this.opts.onChange?.(st)
    return st
  }

  /** Activation request code for offline activation (sent to Digital Target). */
  requestCode(licenseKey: string): string {
    const key = String(licenseKey ?? '').trim().toUpperCase()
    if (!key) throw new AppError('Enter your license key first.', 'VALIDATION')
    return b64url(JSON.stringify({ k: key, d: this.deviceId, n: this.deviceName, a: this.opts.appVersion, o: this.os, t: this.iso() }))
  }

  /** Installs a certificate (from file contents or a pasted activation code). */
  install(text: string, bindPass = false): LicenseStatus {
    let cert: LicenseCertificate
    try {
      cert = parseCertificate(text)
    } catch {
      throw new AppError('This is not a valid DT Solar Pro license file or activation code.', 'LICENSE')
    }
    const s0 = this.readState()
    const r = verifyCertificate(cert, this.opts.publicKeyPem, this.deviceId, (lid) => bindPass || this.passBound(s0, lid))
    if (!r.ok) throw new AppError(r.reason, 'LICENSE')
    const before = this.status(true).payload
    const s = this.readState()
    if (bindPass && r.payload.deviceId === PASS_DEVICE) s.boundPass = { licenseId: r.payload.licenseId, deviceId: this.deviceId }
    // A stored remote block (suspended / revoked / device deactivated) can only be lifted by a certificate that Digital
    // Target issued AFTER that decision (re-approval) or by an online check-in, never by re-installing an older one.
    const remote = this.effectiveRemote(s, r.payload.licenseId)
    if (remote && !((Date.parse(r.payload.issuedAt) || 0) > Date.parse(remote.at))) {
      const what = remote.status === 'deactivated' ? 'This computer was deactivated for this license by Digital Target' : `This license was ${remote.status} by Digital Target`
      throw new AppError(`${what}. This certificate was issued before that decision and cannot restore access. Contact Digital Target.`, remote.status === 'deactivated' ? 'LICENSE_DEVICE' : 'LICENSE')
    }
    this.writeCert(cert)
    if (remote) this.setRemote(s, r.payload.licenseId, null)
    else if (!s.remoteLicenseId) s.remoteStatus = null
    if (!before || before.licenseId !== r.payload.licenseId) {
      s.remotePoweredBy = null
      s.certUpdate = null
    }
    this.writeState(s)
    return this.status(true)
  }

  /* ------------------------------ Firestore REST (no SDK, no server) ------------------------------ */

  private requireClient(): FirestoreRest {
    if (!this.client) throw new AppError('Online activation is not configured in this build. Use offline activation.', 'OFFLINE')
    return this.client
  }

  private static netError(e: unknown, action: string): AppError {
    if (e instanceof AppError) return e
    if (e instanceof FirestoreError) {
      if (e.offline) return new AppError(`${e.message}`, 'OFFLINE')
      if (e.status === 403) return new AppError(`The license service refused the ${action}. Please contact Digital Target.`, 'LICENSE')
      return new AppError(e.message, 'LICENSE')
    }
    return new AppError((e as Error)?.message ?? String(e), 'LICENSE')
  }

  private static randomId(len = 28): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let out = ''
    while (out.length < len) {
      for (const b of randomBytes(len * 2)) {
        if (b < 248) out += chars[b % 62]
        if (out.length === len) break
      }
    }
    return out
  }

  private result(state: ActivationResult['state'], message: string, requestId: string | null = null): ActivationResult {
    return { pending: state === 'pending', state, requestId, message, status: this.status(true) }
  }

  /**
   * Starts (or continues) online activation. Registration details (company, owner, phone, address) and the
   * installation token travel with the request so Digital Target can register the customer. Returns the
   * installed status when approved, or { pending: true } while Digital Target has not yet approved the request.
   */
  async activateOnline(licenseKey: string, registration?: unknown): Promise<ActivationResult> {
    const key = String(licenseKey ?? '').trim().toUpperCase()
    if (!LICENSE_KEY_RE.test(key)) throw new AppError('Enter a valid license key (DTSP-XXXX-XXXX-XXXX-XXXX).', 'VALIDATION')
    const reg = registration === undefined || registration === null ? null : cleanRegistration(registration)
    const client = this.requireClient()
    const s = this.readState()
    if (s.pendingRequest && s.pendingRequest.licenseKey === key) return this.pollActivation(true)
    // One device = one approval: this computer is already activated with this key -> verify instead of asking again.
    const cur = this.status(true)
    if (cur.payload && s.activatedKey === key && cur.mode !== 'device_deactivated') {
      const st = await this.checkIn(true)
      if (!st.canWrite) throw new AppError(st.message, st.blockReason === 'device' ? 'LICENSE_DEVICE' : 'LICENSE')
      if (reg) this.saveRegistration(reg)
      return this.result('approved', 'This computer is already activated with this license key. No new approval is needed.')
    }
    // A valid key activates a new computer at once (within the device limit); approval only where it is required.
    const instant = await this.tryInstant(key, reg)
    if ('state' in instant) return instant
    const id = LicenseService.randomId()
    const now = this.iso()
    const fields: Record<string, unknown> = {
      type: 'activate',
      licenseKey: key,
      deviceId: this.deviceId,
      deviceName: this.deviceName.slice(0, 200),
      appVersion: this.opts.appVersion.slice(0, 40),
      os: this.os.slice(0, 200),
      status: 'pending',
      installToken: this.installToken
    }
    if (reg) Object.assign(fields, { companyName: reg.companyName, ownerName: reg.ownerName, phone: reg.phone, address: reg.address })
    try {
      await client.commit([activationRequestWrite(id, fields)])
    } catch (e) {
      throw LicenseService.netError(e, 'activation request')
    }
    const st = this.readState()
    st.pendingRequest = { id, licenseKey: key, createdAt: now, reason: instant.approval }
    st.activationNotice = null
    if (reg) st.registration = reg
    this.writeState(st)
    this.log('info', `Activation needs approval: ${instant.approval}`)
    return this.result('pending', `${instant.approval} The request was sent to Digital Target — this window updates by itself when it is approved.`, id)
  }

  private lastInstantTry = 0

  /**
   * Instant activation: fetches the activation pass published for this key (activationPasses/{sha256(key)}), verifies
   * its signature, checks the public license status and registers this computer on the license in ONE commit. The
   * Firestore rules accept it only while the license is active, not expired, a device slot is free and this computer
   * was never registered on the license. Returns the activation result, or the reason an admin approval is needed.
   * Throws for final answers (license suspended / revoked / expired) and when offline.
   */
  private async tryInstant(key: string, reg: Registration | null): Promise<ActivationResult | { approval: string }> {
    this.lastInstantTry = this.now()
    const client = this.requireClient()
    const did = this.deviceId
    let pass
    try {
      pass = await client.get(`activationPasses/${createHash('sha256').update(key).digest('hex')}`)
    } catch (e) {
      throw LicenseService.netError(e, 'license check')
    }
    if (!pass || typeof pass.data.cert !== 'string') {
      return { approval: 'This key is not enabled for instant activation (unknown key, or Digital Target has not published it yet), so it needs approval.' }
    }
    let cert: LicenseCertificate
    try {
      cert = parseCertificate(pass.data.cert)
    } catch {
      return { approval: 'The activation pass for this key could not be read, so it needs approval.' }
    }
    const v = verifyCertificate(cert, this.opts.publicKeyPem, did, () => true)
    if (!v.ok || v.payload.deviceId !== PASS_DEVICE) {
      return { approval: `The activation pass for this key could not be verified (${v.ok ? 'not a pass' : v.reason}), so it needs approval.` }
    }
    const p = v.payload
    let statusDoc, deviceDoc
    try {
      ;[statusDoc, deviceDoc] = await Promise.all([client.get(`licenseStatus/${p.licenseId}`), client.get(`licenses/${p.licenseId}/devices/${did}`)])
    } catch (e) {
      throw LicenseService.netError(e, 'license check')
    }
    const block = statusDoc ? remoteDecision(statusDoc.data, did) : null
    if (block === 'suspended' || block === 'revoked') throw new AppError(`This license is ${block}. Please contact Digital Target.`, 'LICENSE')
    const exp = statusDoc ? statusDoc.data.expiresAt : p.expiresAt
    const expMs = exp instanceof Date ? exp.getTime() : typeof exp === 'string' ? Date.parse(exp) : NaN
    if (Number.isFinite(expMs) && expMs < this.now()) throw new AppError('This license has expired. Please contact Digital Target to renew it.', 'LICENSE')
    if (block === 'deactivated' || (deviceDoc && deviceDoc.data.status !== 'active')) {
      return { approval: 'This computer was released or deactivated on this license earlier, so Digital Target must approve it again.' }
    }
    if (!deviceDoc) {
      const fp = `devicesSummary.\`${did}\``
      const info = { deviceName: this.deviceName.slice(0, 200), os: this.os.slice(0, 200), appVersion: this.opts.appVersion.slice(0, 40) }
      try {
        await client.commit([
          {
            path: `licenses/${p.licenseId}`,
            fields: { devicesSummary: { [did]: { ...info, status: 'active', activationType: 'instant', statusNote: '' } }, selfActivatedDevice: did },
            mask: [fp, 'selfActivatedDevice'],
            serverTime: ['updatedAt', `${fp}.activatedAt`],
            increment: { activeDevices: 1 },
            exists: true
          },
          {
            path: `licenses/${p.licenseId}/devices/${did}`,
            fields: { deviceId: did, ...info, status: 'active', activationType: 'instant', statusNote: '', installToken: this.installToken },
            serverTime: ['activatedAt'],
            exists: false
          }
        ])
      } catch (e) {
        if (e instanceof FirestoreError && e.offline) throw LicenseService.netError(e, 'activation')
        this.log('warn', `Instant activation refused: ${(e as Error).message}`)
        return { approval: `All ${p.maxDevices ?? ''} device slot(s) of this license are in use, so Digital Target must approve this computer (for example by replacing an old one).`.replace('All  device', 'All device') }
      }
    }
    this.install(cert.payload + '.' + cert.signature, true)
    const st = this.readState()
    st.pendingRequest = null
    st.activatedKey = key
    st.lastCheckAt = this.iso()
    st.lastCheckError = null
    if (reg) st.registration = reg
    const how = deviceDoc ? 'This computer was already registered on this license — no new slot used.' : 'Activated instantly.'
    st.activationNotice = { kind: 'approved', message: `${how} Licensed to ${p.businessName}.`, at: st.lastCheckAt, licenseKey: key }
    this.writeState(st)
    this.log('info', `License activated instantly (${deviceDoc ? 'already registered' : 'new device slot'}).`)
    return this.result('approved', `${how} Licensed to ${p.businessName}.`)
  }

  /** Checks a pending online activation request and installs the certificate when approved. */
  async pollActivation(force = false): Promise<ActivationResult> {
    const s = this.readState()
    if (!s.pendingRequest) return this.result('none', 'No activation request is pending.')
    const client = this.requireClient()
    let doc
    try {
      doc = await client.get(`activationRequests/${s.pendingRequest.id}`)
    } catch (e) {
      throw LicenseService.netError(e, 'status check')
    }
    if (!doc) {
      s.pendingRequest = null
      s.activationNotice = { kind: 'rejected', message: 'The activation request was not found. Please try activating again.', at: new Date().toISOString() }
      this.writeState(s)
      throw new AppError('The activation request was not found. Please try activating again.', 'LICENSE_REJECTED')
    }
    const state = String(doc.data.status ?? '')
    if (state === 'approved') {
      const cert = typeof doc.data.certificate === 'string' ? doc.data.certificate : ''
      if (!cert) throw new AppError('The approved request does not contain a certificate. Contact Digital Target.', 'LICENSE')
      this.install(cert)
      const st = this.readState()
      const key = st.pendingRequest?.licenseKey
      st.pendingRequest = null
      st.activatedKey = key ?? null
      st.lastCheckAt = this.iso()
      st.lastCheckError = null
      const p = this.status(true).payload
      st.activationNotice = { kind: 'approved', message: p ? `Licensed to ${p.businessName}.` : 'License activated.', at: st.lastCheckAt, licenseKey: key }
      this.writeState(st)
      return this.result('approved', 'License activated successfully.')
    }
    if (state === 'rejected') {
      const msg = (typeof doc.data.message === 'string' && doc.data.message.trim()) || 'The activation request was rejected.'
      s.activationNotice = { kind: 'rejected', message: msg, at: new Date().toISOString(), licenseKey: s.pendingRequest.licenseKey }
      s.pendingRequest = null
      this.writeState(s)
      throw new AppError(`${msg.replace(/[.\s]+$/, '')}. Contact Digital Target if you believe this is a mistake.`, 'LICENSE_REJECTED')
    }
    // Meanwhile a slot may have been freed or instant activation enabled: retry it (at most once a minute).
    if (force || this.now() - this.lastInstantTry > 60_000) {
      try {
        const r = await this.tryInstant(s.pendingRequest.licenseKey, s.registration ?? null)
        if ('state' in r) return r
        const st = this.readState()
        if (st.pendingRequest) {
          st.pendingRequest.reason = r.approval
          this.writeState(st)
        }
      } catch (e) {
        if (!(e instanceof AppError) || e.code !== 'LICENSE') throw e
        const st = this.readState()
        st.activationNotice = { kind: 'rejected', message: e.message, at: new Date().toISOString(), licenseKey: st.pendingRequest?.licenseKey }
        st.pendingRequest = null
        this.writeState(st)
        throw new AppError(e.message, 'LICENSE_REJECTED')
      }
    }
    const reason = this.readState().pendingRequest?.reason
    return this.result('pending', reason ? `Waiting for approval from Digital Target — ${reason}` : 'Waiting for approval from Digital Target…', s.pendingRequest.id)
  }

  cancelPending(): LicenseStatus {
    const s = this.readState()
    s.pendingRequest = null
    this.writeState(s)
    return this.status(true)
  }

  /** True when a protected write should verify online first (last success older than 5 min, no recent failure). */
  needsCheck(): boolean {
    if (!this.client) return false
    const st = this.status(true)
    if (!st.payload || isDetached(st.payload)) return false
    const now = this.now()
    const last = st.lastCheckAt ? Date.parse(st.lastCheckAt) : 0
    if (Number.isFinite(last) && now - last < FRESH_MS && now >= last) return false
    if (this.lastFailureAt && now - this.lastFailureAt < RETRY_AFTER_FAILURE_MS && now >= this.lastFailureAt) return false
    return true
  }

  /**
   * Before a protected write: when online is configured and the last successful verification is older than 5 minutes,
   * runs a check-in first and waits at most `maxWaitMs` (default 4 s). A slow network never blocks longer; the check
   * keeps running and its result applies when it arrives. Returns the current status.
   */
  async ensureFresh(maxWaitMs = WRITE_CHECK_WAIT_MS): Promise<LicenseStatus> {
    if (this.needsCheck()) {
      let timer: ReturnType<typeof setTimeout> | undefined
      await Promise.race([this.runCheck().catch(() => undefined), new Promise<void>((r) => (timer = setTimeout(r, maxWaitMs)))])
      if (timer) clearTimeout(timer)
    }
    return this.status(true)
  }

  /** Start-up / sign-in: starts a check when one is due, never waits, never throws. */
  refreshInBackground(): void {
    try {
      if (this.needsCheck()) void this.runCheck().catch(() => undefined)
    } catch {
      /* never break start-up or sign-in */
    }
  }

  /**
   * Online check-in: reads licenseStatus/{licenseId} — status, deactivated devices, the "Powered by" flag and a
   * re-signed certificate for this device. Network problems never change (or clear) the stored decision.
   * A detached lifetime license is not checked at all. Concurrent calls share one request.
   */
  async checkIn(silent = true): Promise<LicenseStatus> {
    const r = await this.runCheck()
    if (!silent && r.error) throw r.error
    return r.status
  }

  private runCheck(): Promise<{ status: LicenseStatus; error: AppError | null }> {
    if (this.inflight) return this.inflight
    this.inflight = this.doCheck().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async doCheck(): Promise<{ status: LicenseStatus; error: AppError | null }> {
    let pollError: AppError | null = null
    if (this.readState().pendingRequest && this.client) {
      try {
        await this.pollActivation()
      } catch (e) {
        pollError = LicenseService.netError(e, 'status check')
      }
    }
    const now = this.status(true)
    if (!this.client) return { status: now, error: new AppError('Online license checking is not configured in this build.', 'OFFLINE') }
    if (!now.payload) return { status: now, error: pollError }
    if (isDetached(now.payload)) {
      const s = this.readState()
      if (s.lastCheckError) {
        s.lastCheckError = null
        this.writeState(s)
      }
      return { status: this.status(true), error: null }
    }
    const payload = now.payload
    const s = this.readState()
    try {
      const doc = await this.client.get(`licenseStatus/${payload.licenseId}`)
      if (!doc) throw new AppError('License status is not published yet. Contact Digital Target.', 'LICENSE')
      const d = doc.data
      // 1. Status of the license and of this device.
      const block = remoteDecision(d, this.deviceId)
      // 2. A re-signed certificate for this computer (renewal, plan / limit change, detachment) — never while the
      //    license is suspended / revoked or this device is deactivated.
      const certs = d.certs && typeof d.certs === 'object' ? (d.certs as Record<string, unknown>) : {}
      if (!block) {
        const decision = decideCertUpdate({ code: certs[this.deviceId], publicKeyPem: this.opts.publicKeyPem, deviceId: this.deviceId, current: { cert: this.readCert(), payload } })
        if (decision.install) {
          this.writeCert(decision.cert)
          s.certUpdate = { at: this.iso(), summary: decision.summary }
          this.log('info', `License certificate updated from Digital Target: ${decision.summary}`)
        } else if (decision.reason !== 'none' && decision.reason !== 'same') {
          this.log('warn', `Published license certificate ignored: ${decision.message}`)
        }
      } else if (certs[this.deviceId]) {
        this.log('warn', `Published license certificate not installed: the license is ${block === 'deactivated' ? 'deactivated for this computer' : block}.`)
      }
      s.lastCheckAt = this.iso()
      s.lastCheckError = null
      this.setRemote(s, payload.licenseId, block)
      if (block) this.log('warn', `License check: blocked by Digital Target (${block}).`)
      // 3. "Powered by Digital Target" on customer documents.
      if (typeof d.poweredBy === 'boolean') s.remotePoweredBy = d.poweredBy
      this.writeState(s)
      this.lastFailureAt = 0
    } catch (e) {
      const err = LicenseService.netError(e, 'license check')
      s.lastCheckError = err.message
      this.writeState(s)
      this.lastFailureAt = this.now()
      return { status: this.status(true), error: err }
    }
    return { status: this.status(true), error: pollError }
  }

  /**
   * Installs a re-signed certificate published for this computer in licenseStatus/{licenseId}.certs, WITHOUT applying
   * the remote status. Used to reconnect a detached lifetime license on the customer's request (detached licenses do
   * not check in automatically). Returns what happened in plain words.
   */
  async fetchPublishedCertificate(): Promise<{ installed: boolean; message: string; status: LicenseStatus }> {
    const st = this.status(true)
    if (!st.payload) throw new AppError('No license is installed on this computer.', 'LICENSE')
    const client = this.requireClient()
    let doc
    try {
      doc = await client.get(`licenseStatus/${st.payload.licenseId}`)
    } catch (e) {
      throw LicenseService.netError(e, 'certificate check')
    }
    const block = doc ? remoteDecision(doc.data, this.deviceId) : null
    if (block) {
      const s = this.readState()
      this.setRemote(s, st.payload.licenseId, block)
      s.lastCheckAt = this.iso()
      s.lastCheckError = null
      this.writeState(s)
      const status = this.status(true)
      return { installed: false, message: status.message, status }
    }
    const certs = doc && doc.data.certs && typeof doc.data.certs === 'object' ? (doc.data.certs as Record<string, unknown>) : {}
    const decision = decideCertUpdate({ code: certs[this.deviceId], publicKeyPem: this.opts.publicKeyPem, deviceId: this.deviceId, current: { cert: this.readCert(), payload: st.payload } })
    if (!decision.install) {
      const message =
        decision.reason === 'none' || decision.reason === 'same'
          ? 'No new certificate has been published for this computer yet. Ask Digital Target to reconnect your license, then try again.'
          : `The published certificate was not installed: ${decision.message}`
      return { installed: false, message, status: st }
    }
    this.writeCert(decision.cert)
    const s = this.readState()
    s.certUpdate = { at: this.iso(), summary: decision.summary }
    this.writeState(s)
    this.log('info', `License certificate installed on request: ${decision.summary}`)
    // Reconnected: the license is centrally managed again — apply the published status right away.
    const status = isDetached(decision.payload) ? this.status(true) : await this.checkIn(true)
    return { installed: true, message: `Certificate updated: ${decision.summary}.`, status }
  }

  /** Releases this computer: removes the local certificate and tells Digital Target (best effort). */
  async deactivate(): Promise<LicenseStatus> {
    const st = this.status(true)
    if (st.payload && this.client) {
      await this.client
        .commit([
          activationRequestWrite(LicenseService.randomId(), {
            type: 'deactivate',
            licenseId: st.payload.licenseId,
            deviceId: this.deviceId,
            deviceName: this.deviceName.slice(0, 200),
            appVersion: this.opts.appVersion.slice(0, 40),
            os: this.os.slice(0, 200),
            status: 'pending',
            installToken: this.installToken
          })
        ])
        .catch((e) => this.log('warn', `Deactivation notice not delivered: ${(e as Error).message}`))
    }
    if (existsSync(this.certFile)) unlinkSync(this.certFile)
    const s = this.readState()
    s.remotePoweredBy = null
    // A stored remote block is kept: removing and re-installing the certificate must not lift a suspension.
    s.certUpdate = null
    s.activatedKey = null
    this.writeState(s)
    return this.status(true)
  }
}

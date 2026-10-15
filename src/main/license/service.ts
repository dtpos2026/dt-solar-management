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
 */
import { createHash, randomBytes } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { hostname, networkInterfaces, platform, release } from 'os'
import { join } from 'path'
import type { ActivationNotice, ActivationResult, LicenseCertificate, LicensePayload, LicenseStatus, Registration } from './types'
import { TRIAL_LIMITS } from './types'
import { WRITE_MODES, evaluate, parseCertificate, verifyCertificate } from './verify'
import { AppError } from '../services/context'
import { FirestoreError, FirestoreRest, resolveFirestoreConfig, type FirestoreConfig, type RestOptions } from '../cloud/firestore'
import { loadInstallToken, maskToken } from '../cloud/install'
import { decideCertUpdate, isDetached } from '../cloud/certRefresh'
import { log as appLog } from '../log'

interface State {
  trialStartedAt: number
  lastSeenAt: number
  remoteStatus: string | null
  lastCheckAt: string | null
  lastCheckError: string | null
  pendingRequest: { id: string; licenseKey: string; createdAt: string } | null
  /** Latest "Powered by Digital Target" flag published by the Super Admin (overrides the certificate). */
  remotePoweredBy?: boolean | null
  /** v1.1 */
  registration?: Registration | null
  certUpdate?: { at: string; summary: string } | null
  activationNotice?: ActivationNotice | null
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

export interface LicenseServiceOptions {
  dir: string
  publicKeyPem: string
  /** Production Firestore project (overridable for tests with DTSP_FIRESTORE_EMULATOR). null = offline-only build. */
  firestore: { projectId: string; apiKey: string } | null
  appVersion: string
  /** Earliest known trial start persisted in the business DB (survives deleting the license folder). */
  getDbTrialStart?: () => number | null
  setDbTrialStart?: (ts: number) => void
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

  constructor(private opts: LicenseServiceOptions) {
    mkdirSync(opts.dir, { recursive: true })
    this.certFile = join(opts.dir, 'license.json')
    this.stateFile = join(opts.dir, 'state.json')
    this.deviceId = computeDeviceId()
    this.deviceName = hostname()
    this.installToken = loadInstallToken(opts.dir).token
    this.firestoreConfig = resolveFirestoreConfig(opts.firestore, opts.env ?? process.env)
    this.client = this.firestoreConfig ? new FirestoreRest(this.firestoreConfig, opts.rest) : null
  }

  get os(): string {
    return `${platform()} ${release()}`
  }

  get appVersion(): string {
    return this.opts.appVersion
  }

  private readState(): State {
    let s: Partial<State> = {}
    try {
      s = JSON.parse(readFileSync(this.stateFile, 'utf8'))
    } catch {
      s = {}
    }
    const now = Date.now()
    const dbStart = this.opts.getDbTrialStart?.() ?? null
    const candidates = [s.trialStartedAt, dbStart].filter((x): x is number => typeof x === 'number' && x > 0)
    const trialStartedAt = candidates.length ? Math.min(...candidates) : now
    if (!dbStart) this.opts.setDbTrialStart?.(trialStartedAt)
    return {
      trialStartedAt,
      lastSeenAt: typeof s.lastSeenAt === 'number' ? s.lastSeenAt : now,
      remoteStatus: s.remoteStatus ?? null,
      lastCheckAt: s.lastCheckAt ?? null,
      lastCheckError: s.lastCheckError ?? null,
      pendingRequest: s.pendingRequest ?? null,
      remotePoweredBy: typeof s.remotePoweredBy === 'boolean' ? s.remotePoweredBy : null,
      registration: s.registration ?? null,
      certUpdate: s.certUpdate ?? null,
      activationNotice: s.activationNotice ?? null
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
    const now = Date.now()
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
      const r = verifyCertificate(cert, this.opts.publicKeyPem, this.deviceId)
      if (r.ok) payload = r.payload
      else certError = r.reason
    }
    const ev = evaluate({
      now: Date.now(),
      payload,
      certError,
      trialStartedAt: s.trialStartedAt,
      lastSeenAt: s.lastSeenAt,
      remoteStatus: s.remoteStatus,
      lastCheckAt: s.lastCheckAt ? Date.parse(s.lastCheckAt) : null
    })
    const detached = isDetached(payload)
    const st: LicenseStatus = {
      mode: ev.mode,
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
    return b64url(JSON.stringify({ k: key, d: this.deviceId, n: this.deviceName, a: this.opts.appVersion, o: this.os, t: new Date().toISOString() }))
  }

  /** Installs a certificate (from file contents or a pasted activation code). */
  install(text: string): LicenseStatus {
    let cert: LicenseCertificate
    try {
      cert = parseCertificate(text)
    } catch {
      throw new AppError('This is not a valid DT Solar Pro license file or activation code.', 'LICENSE')
    }
    const r = verifyCertificate(cert, this.opts.publicKeyPem, this.deviceId)
    if (!r.ok) throw new AppError(r.reason, 'LICENSE')
    const before = this.status(true).payload
    this.writeCert(cert)
    const s = this.readState()
    s.remoteStatus = null
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
    if (s.pendingRequest && s.pendingRequest.licenseKey === key) return this.pollActivation()
    const id = LicenseService.randomId()
    const now = new Date().toISOString()
    const fields: Record<string, unknown> = {
      type: 'activate',
      licenseKey: key,
      deviceId: this.deviceId,
      deviceName: this.deviceName.slice(0, 200),
      appVersion: this.opts.appVersion.slice(0, 40),
      os: this.os.slice(0, 200),
      status: 'pending',
      createdAt: new Date(now),
      installToken: this.installToken
    }
    if (reg) Object.assign(fields, { companyName: reg.companyName, ownerName: reg.ownerName, phone: reg.phone, address: reg.address })
    try {
      await client.create('activationRequests', id, fields)
    } catch (e) {
      throw LicenseService.netError(e, 'activation request')
    }
    const st = this.readState()
    st.pendingRequest = { id, licenseKey: key, createdAt: now }
    st.activationNotice = null
    if (reg) st.registration = reg
    this.writeState(st)
    return this.result('pending', 'Activation request sent to Digital Target. It will be approved shortly — keep this window open or check again later.', id)
  }

  /** Checks a pending online activation request and installs the certificate when approved. */
  async pollActivation(): Promise<ActivationResult> {
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
      st.lastCheckAt = new Date().toISOString()
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
    return this.result('pending', 'Waiting for approval from Digital Target…', s.pendingRequest.id)
  }

  cancelPending(): LicenseStatus {
    const s = this.readState()
    s.pendingRequest = null
    this.writeState(s)
    return this.status(true)
  }

  /**
   * Online check-in: reads licenseStatus/{licenseId} — status, deactivated devices, the "Powered by" flag and a
   * re-signed certificate for this device. Network problems never change the license when silent.
   * A detached lifetime license is not checked at all.
   */
  async checkIn(silent = true): Promise<LicenseStatus> {
    if (this.readState().pendingRequest && this.client) {
      try {
        await this.pollActivation()
      } catch (e) {
        if (!silent) throw e
      }
    }
    const now = this.status(true)
    if (!now.payload || !this.client) {
      if (!silent && !this.client) throw new AppError('Online license checking is not configured in this build.', 'OFFLINE')
      return now
    }
    if (isDetached(now.payload)) {
      const s = this.readState()
      if (s.lastCheckError) {
        s.lastCheckError = null
        this.writeState(s)
      }
      return this.status(true)
    }
    const payload = now.payload
    const s = this.readState()
    try {
      const doc = await this.client.get(`licenseStatus/${payload.licenseId}`)
      if (!doc) throw new AppError('License status is not published yet. Contact Digital Target.', 'LICENSE')
      const d = doc.data
      // 1. A re-signed certificate for this computer (renewal, plan / limit change, detachment).
      const certs = d.certs && typeof d.certs === 'object' ? (d.certs as Record<string, unknown>) : {}
      const decision = decideCertUpdate({ code: certs[this.deviceId], publicKeyPem: this.opts.publicKeyPem, deviceId: this.deviceId, current: { cert: this.readCert(), payload } })
      if (decision.install) {
        this.writeCert(decision.cert)
        s.certUpdate = { at: new Date().toISOString(), summary: decision.summary }
        (this.opts.log ?? appLog)('info', `License certificate updated from Digital Target: ${decision.summary}`)
      } else if (decision.reason !== 'none' && decision.reason !== 'same') {
        (this.opts.log ?? appLog)('warn', `Published license certificate ignored: ${decision.message}`)
      }
      // 2. Status of the license and of this device.
      const status = typeof d.status === 'string' ? d.status : 'active'
      const deactivated = Array.isArray(d.deactivatedDevices) ? (d.deactivatedDevices as unknown[]).map(String) : []
      s.lastCheckAt = new Date().toISOString()
      s.lastCheckError = null
      s.remoteStatus = status === 'suspended' || status === 'revoked' ? status : deactivated.includes(this.deviceId) ? 'revoked' : null
      // 3. "Powered by Digital Target" on customer documents.
      if (typeof d.poweredBy === 'boolean') s.remotePoweredBy = d.poweredBy
      this.writeState(s)
    } catch (e) {
      const err = LicenseService.netError(e, 'license check')
      s.lastCheckError = err.message
      this.writeState(s)
      if (!silent) throw err
    }
    return this.status(true)
  }

  /** Releases this computer: removes the local certificate and tells Digital Target (best effort). */
  async deactivate(): Promise<LicenseStatus> {
    const st = this.status(true)
    if (st.payload && this.client) {
      await this.client
        .create('activationRequests', LicenseService.randomId(), {
          type: 'deactivate',
          licenseId: st.payload.licenseId,
          deviceId: this.deviceId,
          deviceName: this.deviceName.slice(0, 200),
          appVersion: this.opts.appVersion.slice(0, 40),
          os: this.os.slice(0, 200),
          status: 'pending',
          createdAt: new Date(),
          installToken: this.installToken
        })
        .catch(() => undefined)
    }
    if (existsSync(this.certFile)) unlinkSync(this.certFile)
    const s = this.readState()
    s.remotePoweredBy = null
    s.remoteStatus = null
    s.certUpdate = null
    this.writeState(s)
    return this.status(true)
  }
}

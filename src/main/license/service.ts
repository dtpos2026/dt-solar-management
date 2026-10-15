/**
 * License service for the desktop app.
 *
 * Offline policy (see docs/LICENSING.md):
 *  - A license is a certificate signed (Ed25519) by Digital Target. The app only holds the PUBLIC key.
 *  - The certificate is bound to this computer's device id and carries limits (firms, users), expiry and
 *    an optional "lease" date before which the app must check in online. After the lease, a grace period applies.
 *  - No signing server is needed (works on Firebase's free Spark plan): online activation creates an
 *    "activation request" document in Firestore; Digital Target's Super Admin panel signs the certificate
 *    (private key stays on the admin's computer) and writes it back; the app picks it up and installs it.
 *  - Check-ins read licenseStatus/{licenseId} from Firestore whenever internet is available. Suspension /
 *    revocation / device deactivation take effect at the next successful check-in, or when the check-in
 *    interval + grace period runs out on a computer that stays offline.
 *  - A license problem NEVER deletes or modifies business data. At worst the app becomes read-only
 *    (view, print, export and backup still work).
 */
import { createHash, randomBytes } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs'
import { hostname, networkInterfaces, platform, release } from 'os'
import { join } from 'path'
import type { LicenseCertificate, LicensePayload, LicenseStatus } from './types'
import { TRIAL_LIMITS } from './types'
import { WRITE_MODES, evaluate, parseCertificate, verifyCertificate } from './verify'

interface State {
  trialStartedAt: number
  lastSeenAt: number
  remoteStatus: string | null
  lastCheckAt: string | null
  lastCheckError: string | null
  pendingRequest: { id: string; licenseKey: string; createdAt: string } | null
  /** Latest "Powered by Digital Target" flag published by the Super Admin (overrides the certificate). */
  remotePoweredBy?: boolean | null
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

export interface FirestoreConfig {
  projectId: string
  apiKey: string
}

export interface LicenseServiceOptions {
  dir: string
  publicKeyPem: string
  firestore: FirestoreConfig | null
  appVersion: string
  /** Earliest known trial start persisted in the business DB (survives deleting the license folder). */
  getDbTrialStart?: () => number | null
  setDbTrialStart?: (ts: number) => void
  onChange?: (s: LicenseStatus) => void
}

export class LicenseService {
  readonly deviceId: string
  readonly deviceName: string
  private certFile: string
  private stateFile: string
  private cached: LicenseStatus | null = null

  constructor(private opts: LicenseServiceOptions) {
    mkdirSync(opts.dir, { recursive: true })
    this.certFile = join(opts.dir, 'license.json')
    this.stateFile = join(opts.dir, 'state.json')
    this.deviceId = computeDeviceId()
    this.deviceName = hostname()
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
      remotePoweredBy: typeof s.remotePoweredBy === 'boolean' ? s.remotePoweredBy : null
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

  get onlineConfigured(): boolean {
    return !!this.opts.firestore?.projectId && !!this.opts.firestore?.apiKey
  }

  get signingConfigured(): boolean {
    return this.opts.publicKeyPem.includes('BEGIN PUBLIC KEY')
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
      poweredBy: s.remotePoweredBy ?? payload?.poweredBy ?? false,
      detached: !!payload?.detached
    }
    const changed = !this.cached || this.cached.mode !== st.mode || this.cached.message !== st.message
    this.cached = st
    if (changed) this.opts.onChange?.(st)
    return st
  }

  /** Activation request code for offline activation (sent to Digital Target). */
  requestCode(licenseKey: string): string {
    const key = String(licenseKey ?? '').trim().toUpperCase()
    if (!key) throw new Error('Enter your license key first.')
    return b64url(
      JSON.stringify({ k: key, d: this.deviceId, n: this.deviceName, a: this.opts.appVersion, o: `${platform()} ${release()}`, t: new Date().toISOString() })
    )
  }

  /** Installs a certificate (from file contents or a pasted activation code). */
  install(text: string): LicenseStatus {
    const cert = parseCertificate(text)
    const r = verifyCertificate(cert, this.opts.publicKeyPem, this.deviceId)
    if (!r.ok) throw new Error(r.reason)
    const tmp = this.certFile + '.tmp'
    writeFileSync(tmp, JSON.stringify(cert, null, 2))
    renameSync(tmp, this.certFile)
    const s = this.readState()
    s.remoteStatus = null
    this.writeState(s)
    return this.status(true)
  }

  /* ------------------------------ Firestore REST (no SDK, no server) ------------------------------ */

  private docUrl(path: string): string {
    const fs = this.opts.firestore!
    return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(fs.projectId)}/databases/(default)/documents/${path}`
  }

  private async rest(method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ status: number; json: Record<string, any> }> { // eslint-disable-line @typescript-eslint/no-explicit-any
    if (!this.onlineConfigured) throw new Error('Online activation is not configured in this build. Use offline activation.')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    try {
      const sep = url.includes('?') ? '&' : '?'
      const res = await fetch(`${url}${sep}key=${encodeURIComponent(this.opts.firestore!.apiKey)}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl.signal
      })
      const json = (await res.json().catch(() => ({}))) as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
      return { status: res.status, json }
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new Error('The license service did not respond. Check your internet connection.')
      throw new Error('Could not reach the license service. Check your internet connection.')
    } finally {
      clearTimeout(timer)
    }
  }

  private static field(doc: Record<string, any>, name: string): string | null { // eslint-disable-line @typescript-eslint/no-explicit-any
    const f = doc?.fields?.[name]
    if (!f) return null
    return f.stringValue ?? f.timestampValue ?? (f.integerValue !== undefined ? String(f.integerValue) : null)
  }

  private static randomId(len = 28): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
    let out = ''
    for (const b of randomBytes(len)) out += chars[b % chars.length]
    return out
  }

  /**
   * Starts (or continues) online activation. Returns the installed status when approved, or
   * { pending: true } while Digital Target has not yet approved the request.
   */
  async activateOnline(licenseKey: string): Promise<{ pending: boolean; requestId: string | null; message: string; status: LicenseStatus }> {
    const key = String(licenseKey ?? '').trim().toUpperCase()
    if (!/^DTSP(-[A-Z0-9]{4}){4}$/.test(key)) throw new Error('Enter a valid license key (DTSP-XXXX-XXXX-XXXX-XXXX).')
    const s = this.readState()
    if (s.pendingRequest && s.pendingRequest.licenseKey === key) return this.pollActivation()
    const id = LicenseService.randomId()
    const now = new Date().toISOString()
    const str = (v: string): { stringValue: string } => ({ stringValue: v.slice(0, 200) })
    const r = await this.rest('POST', this.docUrl(`activationRequests?documentId=${id}`), {
      fields: {
        type: str('activate'),
        licenseKey: str(key),
        deviceId: str(this.deviceId),
        deviceName: str(this.deviceName),
        appVersion: str(this.opts.appVersion),
        os: str(`${platform()} ${release()}`),
        status: str('pending'),
        createdAt: { timestampValue: now }
      }
    })
    if (r.status >= 300) throw new Error(r.status === 403 ? 'The license service refused the request. Please contact Digital Target.' : `License service error (${r.status}).`)
    s.pendingRequest = { id, licenseKey: key, createdAt: now }
    this.writeState(s)
    return { pending: true, requestId: id, message: 'Activation request sent to Digital Target. It will be approved shortly — keep this window open or check again later.', status: this.status(true) }
  }

  /** Checks a pending online activation request and installs the certificate when approved. */
  async pollActivation(): Promise<{ pending: boolean; requestId: string | null; message: string; status: LicenseStatus }> {
    const s = this.readState()
    if (!s.pendingRequest) return { pending: false, requestId: null, message: 'No activation request is pending.', status: this.status(true) }
    const r = await this.rest('GET', this.docUrl(`activationRequests/${s.pendingRequest.id}`))
    if (r.status === 404) {
      s.pendingRequest = null
      this.writeState(s)
      throw new Error('The activation request was not found. Please try activating again.')
    }
    if (r.status >= 300) throw new Error(`License service error (${r.status}).`)
    const state = LicenseService.field(r.json, 'status')
    if (state === 'approved') {
      const cert = LicenseService.field(r.json, 'certificate')
      if (!cert) throw new Error('The approved request does not contain a certificate. Contact Digital Target.')
      const status = this.install(cert)
      const st = this.readState()
      st.pendingRequest = null
      st.lastCheckAt = new Date().toISOString()
      st.lastCheckError = null
      this.writeState(st)
      return { pending: false, requestId: null, message: 'License activated successfully.', status: this.status(true) ?? status }
    }
    if (state === 'rejected') {
      const msg = LicenseService.field(r.json, 'message') || 'The activation request was rejected.'
      s.pendingRequest = null
      this.writeState(s)
      throw new Error(`${msg} Contact Digital Target if you believe this is a mistake.`)
    }
    return { pending: true, requestId: s.pendingRequest.id, message: 'Waiting for approval from Digital Target…', status: this.status(true) }
  }

  cancelPending(): LicenseStatus {
    const s = this.readState()
    s.pendingRequest = null
    this.writeState(s)
    return this.status(true)
  }

  /** Online check-in: reads licenseStatus/{licenseId}. Network problems never change the license when silent. */
  async checkIn(silent = true): Promise<LicenseStatus> {
    const st = this.status(true)
    if (this.readState().pendingRequest) {
      try {
        await this.pollActivation()
      } catch (e) {
        if (!silent) throw e
      }
    }
    if (!st.payload || !this.onlineConfigured) {
      if (!silent && !this.onlineConfigured) throw new Error('Online license checking is not configured in this build.')
      return this.status(true)
    }
    const s = this.readState()
    try {
      const r = await this.rest('GET', this.docUrl(`licenseStatus/${encodeURIComponent(st.payload.licenseId)}`))
      if (r.status === 404) throw new Error('License status is not published yet. Contact Digital Target.')
      if (r.status >= 300) throw new Error(`License service error (${r.status}).`)
      const status = LicenseService.field(r.json, 'status') ?? 'active'
      const deactivated: string[] = (r.json?.fields?.deactivatedDevices?.arrayValue?.values ?? []).map((v: { stringValue?: string }) => v.stringValue ?? '')
      s.lastCheckAt = new Date().toISOString()
      s.lastCheckError = null
      s.remoteStatus = status === 'suspended' || status === 'revoked' ? status : deactivated.includes(this.deviceId) ? 'revoked' : null
      this.writeState(s)
    } catch (e) {
      s.lastCheckError = (e as Error).message
      this.writeState(s)
      if (!silent) throw e
    }
    return this.status(true)
  }

  /** Releases this computer: removes the local certificate and tells Digital Target (best effort). */
  async deactivate(): Promise<LicenseStatus> {
    const st = this.status(true)
    if (st.payload && this.onlineConfigured) {
      const str = (v: string): { stringValue: string } => ({ stringValue: v.slice(0, 200) })
      await this.rest('POST', this.docUrl(`activationRequests?documentId=${LicenseService.randomId()}`), {
        fields: {
          type: str('deactivate'),
          licenseId: str(st.payload.licenseId),
          deviceId: str(this.deviceId),
          deviceName: str(this.deviceName),
          appVersion: str(this.opts.appVersion),
          os: str(`${platform()} ${release()}`),
          status: str('pending'),
          createdAt: { timestampValue: new Date().toISOString() }
        }
      }).catch(() => undefined)
    }
    if (existsSync(this.certFile)) unlinkSync(this.certFile)
    return this.status(true)
  }
}

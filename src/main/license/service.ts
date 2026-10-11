/**
 * License service for the desktop app.
 *
 * Offline policy (see docs/LICENSING.md):
 *  - A license is a certificate signed (Ed25519) by Digital Target. The app only holds the PUBLIC key.
 *  - The certificate is bound to this computer's device id and carries limits (firms, users), expiry and
 *    an optional "lease" date before which the app must check in online. After the lease, a grace period applies.
 *  - Check-ins happen automatically when internet is available. Suspension / revocation take effect at the next
 *    successful check-in (or when the lease + grace period runs out on a disconnected computer).
 *  - A license problem NEVER deletes or modifies business data. At worst the app becomes read-only
 *    (view, print, export and backup still work).
 */
import { createHash } from 'crypto'
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

export interface LicenseServiceOptions {
  dir: string
  publicKeyPem: string
  apiUrl: string
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
      lastCheckError: s.lastCheckError ?? null
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
    return /^https:\/\//.test(this.opts.apiUrl)
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
    const ev = evaluate({ now: Date.now(), payload, certError, trialStartedAt: s.trialStartedAt, lastSeenAt: s.lastSeenAt, remoteStatus: s.remoteStatus })
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
      onlineConfigured: this.onlineConfigured,
      signingConfigured: this.signingConfigured,
      maxFirms: payload ? payload.maxFirms : TRIAL_LIMITS.maxFirms,
      maxUsers: payload ? payload.maxUsers : TRIAL_LIMITS.maxUsers
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

  private async post(path: string, body: unknown): Promise<Record<string, unknown>> {
    if (!this.onlineConfigured) throw new Error('Online activation is not configured in this build. Use offline activation.')
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    try {
      const res = await fetch(`${this.opts.apiUrl.replace(/\/$/, '')}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal
      })
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>
      if (!res.ok) throw new Error(String(json.error || `License server error (${res.status}).`))
      return json
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new Error('License server did not respond. Check your internet connection.')
      if (e instanceof TypeError) throw new Error('Could not reach the license server. Check your internet connection.')
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  async activateOnline(licenseKey: string): Promise<LicenseStatus> {
    const key = String(licenseKey ?? '').trim().toUpperCase()
    if (!key) throw new Error('Enter your license key.')
    const r = await this.post('activate', {
      licenseKey: key,
      deviceId: this.deviceId,
      deviceName: this.deviceName,
      appVersion: this.opts.appVersion,
      os: `${platform()} ${release()}`
    })
    if (!r.certificate) throw new Error('License server did not return a certificate.')
    const st = this.install(JSON.stringify(r.certificate))
    const s = this.readState()
    s.lastCheckAt = new Date().toISOString()
    s.lastCheckError = null
    this.writeState(s)
    return this.status(true) ?? st
  }

  /** Online check-in: renews the lease / picks up suspension or revocation. Never throws for network errors when silent. */
  async checkIn(silent = true): Promise<LicenseStatus> {
    const cert = this.readCert()
    const st = this.status(true)
    if (!cert || !st.payload || !this.onlineConfigured) {
      if (!silent && !this.onlineConfigured) throw new Error('Online license checking is not configured in this build.')
      return st
    }
    const s = this.readState()
    try {
      const r = await this.post('checkin', { licenseId: st.payload.licenseId, deviceId: this.deviceId, appVersion: this.opts.appVersion })
      s.lastCheckAt = new Date().toISOString()
      s.lastCheckError = null
      const status = String(r.status ?? 'active')
      s.remoteStatus = status === 'suspended' || status === 'revoked' ? status : null
      this.writeState(s)
      if (r.certificate && s.remoteStatus === null) {
        try {
          this.install(JSON.stringify(r.certificate))
        } catch {
          /* keep the existing certificate */
        }
      }
    } catch (e) {
      s.lastCheckError = (e as Error).message
      this.writeState(s)
      if (!silent) throw e
    }
    return this.status(true)
  }

  /** Releases this computer's activation (online) and removes the local certificate. */
  async deactivate(): Promise<LicenseStatus> {
    const st = this.status(true)
    if (st.payload && this.onlineConfigured) {
      await this.post('deactivate', { licenseId: st.payload.licenseId, deviceId: this.deviceId })
    }
    if (existsSync(this.certFile)) unlinkSync(this.certFile)
    return this.status(true)
  }
}

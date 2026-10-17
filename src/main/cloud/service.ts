/**
 * Online features of one installation: device heartbeat (with consented location) and support messages.
 * Electron-free (unit and emulator tested); src/main/cloud/worker.ts wires it to the running app.
 */
import type { DB } from '../db'
import type { LicenseStatus, Registration } from '../license/types'
import { AppError, Ctx, audit, getSetting, setSetting } from '../services/context'
import type { FirestoreRest } from './firestore'
import { buildHeartbeat, heartbeatWrite, type HeartbeatPayload } from './heartbeat'
import {
  DEVICE_RETRY_MS,
  DeviceLocationError,
  buildLocation,
  deviceFixFresh,
  normalizeMode,
  readDeviceLocation,
  type DeviceFix,
  type HeartbeatLocation,
  type LocationMode,
  type LocationStatus
} from './location'
import { maskToken } from './install'
import { loadCloudState, saveCloudState, type CloudState, type HeartbeatRecord } from './state'
import * as support from './support'
import { resetState } from '../services/adminReset'
import { describeVersion, type VersionInfo } from '../../shared/version'

export const HEARTBEAT_EVERY_MS = 15 * 60_000
export const SUPPORT_BACKGROUND_EVERY_MS = 15 * 60_000
export const VERSION_CHECK_MS = 6 * 3600_000

export interface LicenseLike {
  readonly deviceId: string
  readonly deviceName: string
  readonly installToken: string
  readonly os: string
  readonly appVersion: string
  readonly client: FirestoreRest | null
  status(refresh?: boolean): LicenseStatus
  registration(): Registration | null
}

export interface CloudServiceOptions {
  dir: string
  license: LicenseLike
  getDb: () => DB | null
  getSession?: () => { firmId: number; fullName: string } | null
  /** Tests: Windows location service reader (default: PowerShell GeoCoordinateWatcher). */
  deviceLocate?: () => Promise<DeviceFix>
  /** Tests: clock. */
  now?: () => number
  onIncoming?: (msgs: support.IncomingMessage[]) => void
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
  /** Automatic (timer) heartbeats and support sync. false in development builds unless enabled explicitly. */
  background?: boolean
}

export interface LocationInfo {
  mode: LocationMode
  /** The owner has been asked (answered yes or no). */
  prompted: boolean
  status: LocationStatus
  location: HeartbeatLocation | null
  /** Why no position is sent (plain text). */
  note: string | null
  /** Windows location service: last position (accuracy, time) and why it is unavailable. */
  device: { accuracyKm: number; fetchedAt: string } | null
  deviceError: string | null
}

export class CloudService {
  private state: CloudState
  private hbInFlight: Promise<HeartbeatRecord> | null = null
  private syncInFlight: Promise<support.SyncResult> | null = null
  private nextRound: Promise<support.SyncResult> | null = null
  private backoff = new Map<string, number>()
  private timers: Array<ReturnType<typeof setTimeout>> = []

  constructor(private opts: CloudServiceOptions) {
    this.state = loadCloudState(opts.dir)
    const db = opts.getDb()
    if (db) support.recoverInterrupted(db)
  }

  private save(): void {
    try {
      saveCloudState(this.opts.dir, this.state)
    } catch (e) {
      this.opts.log?.('warn', `Could not save online state: ${(e as Error).message}`)
    }
  }

  private nowMs(): number {
    return this.opts.now?.() ?? Date.now()
  }

  get online(): boolean {
    return !!this.opts.license.client
  }

  /* ------------------------------------------------ business info ------------------------------------------------ */

  /** Active firm (signed-in user) or the default firm; registration company name before setup. */
  businessInfo(): { companyName: string; firmPhone: string; firms: number; firmsActive: number; users: number; ownerName: string } {
    const db = this.opts.getDb()
    const reg = this.opts.license.registration()
    let companyName = ''
    let firmPhone = ''
    let firms = 0
    let firmsActive = 0
    let users = 0
    let ownerName = ''
    if (db) {
      try {
        const session = this.opts.getSession?.() ?? null
        const firm = ((session ? db.prepare('SELECT name, phone FROM firms WHERE id = ?').get(session.firmId) : undefined) ??
          db.prepare('SELECT name, phone FROM firms ORDER BY is_default DESC, id LIMIT 1').get()) as { name: string; phone: string | null } | undefined
        companyName = firm?.name ?? ''
        firmPhone = firm?.phone ?? ''
        firms = (db.prepare('SELECT COUNT(*) AS c FROM firms').get() as { c: number }).c
        firmsActive = (db.prepare('SELECT COUNT(*) AS c FROM firms WHERE is_active = 1').get() as { c: number }).c
        users = (db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_active = 1').get() as { c: number }).c
        ownerName = session?.fullName || ((db.prepare('SELECT full_name FROM users WHERE is_owner = 1 ORDER BY id LIMIT 1').get() as { full_name: string } | undefined)?.full_name ?? '')
      } catch (e) {
        this.opts.log?.('warn', `Heartbeat: could not read business info: ${(e as Error).message}`)
      }
    }
    return { companyName: companyName || reg?.companyName || '', firmPhone, firms, firmsActive, users, ownerName: reg?.ownerName || ownerName }
  }

  /* ------------------------------------------------ location ------------------------------------------------ */

  /** Consent (mode) and whether the owner has been asked yet. Earlier IP / manual modes count as "off, not asked". */
  locationSettings(): { mode: LocationMode; prompted: boolean } {
    const db = this.opts.getDb()
    if (!db) return { mode: 'off', prompted: false }
    const raw = getSetting<unknown>(db, 'location_sharing', 'off')
    const mode = normalizeMode(raw)
    const legacy = raw === 'approximate' || raw === 'manual'
    return { mode, prompted: legacy ? false : getSetting<boolean>(db, 'location_prompted', false) === true }
  }

  /** The owner still has to be asked: licensed installation, never asked. */
  locationPromptNeeded(): boolean {
    const { prompted } = this.locationSettings()
    return !prompted && !!this.opts.license.status().payload
  }

  /**
   * Resolves the location to send now and why there is none. `read` = allowed to read the Windows location service when the
   * last reading is stale (30 minutes; 15 minutes after a failure). No other source is ever used.
   */
  async location(read = true): Promise<LocationInfo> {
    const { mode, prompted } = this.locationSettings()
    const info: LocationInfo = { mode, prompted, status: 'not_asked', location: null, note: null, device: null, deviceError: null }
    if (mode !== 'device') {
      info.status = prompted ? 'declined' : 'not_asked'
      info.note = prompted ? 'Location sharing is turned off on this computer.' : 'Location sharing has not been set up on this computer yet.'
      return info
    }
    const now = this.nowMs()
    const lastTry = this.state.deviceAttemptAt ? Date.parse(this.state.deviceAttemptAt) : 0
    const retryOk = !(Number.isFinite(lastTry) && now - lastTry < DEVICE_RETRY_MS && now >= lastTry)
    if (read && !deviceFixFresh(this.state.device, now) && (retryOk || !this.state.deviceError)) {
      this.state.deviceAttemptAt = new Date(now).toISOString()
      try {
        this.state.device = await (this.opts.deviceLocate ?? (() => readDeviceLocation()))()
        this.state.deviceError = null
        this.state.deviceErrorKind = null
      } catch (e) {
        // Unavailable: report why. An old fix is not reused and no other source is used.
        this.state.device = null
        this.state.deviceError = (e as Error).message
        this.state.deviceErrorKind = e instanceof DeviceLocationError ? e.kind : 'unavailable'
      }
      this.save()
    }
    const d = deviceFixFresh(this.state.device, now) ? this.state.device : null
    info.device = this.state.device ? { accuracyKm: this.state.device.accuracyKm, fetchedAt: this.state.device.fetchedAt } : null
    info.deviceError = this.state.deviceError
    info.location = buildLocation('device', { device: d })
    if (info.location) {
      info.status = 'sharing'
    } else if (this.state.deviceError) {
      info.status = this.state.deviceErrorKind ?? 'unavailable'
      info.note = this.state.deviceError
    } else {
      info.status = 'waiting'
      info.note = 'The position is read from Windows shortly; it is then updated automatically.'
    }
    return info
  }

  /**
   * The owner's answer to the consent question (or a later change in Settings). `allow` turns precise sharing on: the position is
   * read from Windows right away so the answer shows whether Windows allows it. Declining is final until the owner changes it.
   */
  async answerLocation(ctx: Ctx, allow: boolean): Promise<LocationInfo> {
    const prev = this.locationSettings()
    const mode: LocationMode = allow ? 'device' : 'off'
    ctx.db.transaction(() => {
      setSetting(ctx.db, 'location_sharing', mode)
      setSetting(ctx.db, 'location_prompted', true)
    })()
    if (!allow) {
      this.state.device = null
      this.state.deviceError = null
      this.state.deviceErrorKind = null
      this.state.deviceAttemptAt = null
    } else {
      this.state.deviceAttemptAt = null
      this.state.deviceError = null
      this.state.deviceErrorKind = null
    }
    this.save()
    audit(ctx, 'update', 'settings', null, `Location sharing with Digital Target: ${allow ? "on (this computer's location service)" : 'off'}`, { before: prev.mode, after: mode })
    const info = await this.location(true)
    // The change (a withdrawn position included) reaches Digital Target right away when online.
    if (this.online) await this.sendHeartbeat().catch(() => undefined)
    return info
  }

  /* ------------------------------------------------ heartbeat ------------------------------------------------ */

  async heartbeatPayload(lookup = true): Promise<{ payload: HeartbeatPayload; location: LocationInfo }> {
    const lic = this.opts.license
    const st = lic.status(true)
    const biz = this.businessInfo()
    const loc = await this.location(lookup)
    const payload = buildHeartbeat({
      deviceId: lic.deviceId,
      licenseId: st.payload?.licenseId ?? '',
      deviceName: lic.deviceName,
      os: lic.os,
      appVersion: lic.appVersion,
      companyName: biz.companyName,
      mode: st.mode,
      lastCheckAt: st.lastCheckAt ?? '',
      firms: biz.firms,
      firmsActive: biz.firmsActive,
      users: biz.users,
      location: loc.location,
      locationStatus: loc.status,
      locationNote: loc.location ? null : loc.note || 'No position available yet.',
      resetState: this.opts.getDb() ? resetState(this.opts.getDb()!) : ''
    })
    return { payload, location: loc }
  }

  heartbeatRecord(): HeartbeatRecord {
    return { ...this.state.heartbeat }
  }

  /** Sends heartbeats/{installToken}. Never throws — the record says what happened. */
  sendHeartbeat(): Promise<HeartbeatRecord> {
    if (this.hbInFlight) return this.hbInFlight
    this.hbInFlight = (async () => {
      const rec = this.state.heartbeat
      rec.lastAttemptAt = new Date().toISOString()
      const client = this.opts.license.client
      if (!client) {
        rec.ok = false
        rec.error = 'Online features are not available in this build.'
      } else {
        try {
          const { payload } = await this.heartbeatPayload(true)
          await client.commit([heartbeatWrite(this.opts.license.installToken, payload)])
          rec.ok = true
          rec.error = null
          rec.lastOkAt = new Date().toISOString()
          rec.lastPayload = payload
          void this.checkLatestVersion().catch(() => undefined)
        } catch (e) {
          rec.ok = false
          rec.error = (e as Error).message
        }
      }
      this.save()
      return { ...rec }
    })().finally(() => {
      this.hbInFlight = null
    })
    return this.hbInFlight
  }

  async overview(): Promise<Record<string, unknown>> {
    const { payload, location } = await this.heartbeatPayload(false)
    return {
      online: this.online,
      emulator: !!this.opts.license.client?.cfg.emulator,
      background: this.opts.background !== false,
      installId: maskToken(this.opts.license.installToken),
      everyMinutes: HEARTBEAT_EVERY_MS / 60_000,
      location,
      preview: { documentId: `heartbeats/${maskToken(this.opts.license.installToken)}`, ...payload, lastSeen: '(server time)' },
      heartbeat: this.heartbeatRecord()
    }
  }

  /* ------------------------------------------------ version ------------------------------------------------ */

  /** Installed version and the latest one Digital Target published (read from publicSettings/version, at most every 6 hours). */
  versionInfo(): VersionInfo {
    return describeVersion(this.opts.license.appVersion, this.state.version)
  }

  async checkLatestVersion(force = false): Promise<VersionInfo> {
    const client = this.opts.license.client
    const last = this.state.version?.checkedAt ? Date.parse(this.state.version.checkedAt) : 0
    if (client && (force || !(this.nowMs() - last < VERSION_CHECK_MS && this.nowMs() >= last))) {
      try {
        const doc = await client.get('publicSettings/version')
        const d = (doc?.data ?? {}) as Record<string, unknown>
        const str = (v: unknown, n: number): string => (typeof v === 'string' ? v.trim().slice(0, n) : '')
        this.state.version = { latest: str(d.latest, 20), minimum: str(d.minimum, 20), notes: str(d.notes, 500), url: /^https:\/\//.test(str(d.url, 300)) ? str(d.url, 300) : '', checkedAt: new Date(this.nowMs()).toISOString() }
        this.save()
      } catch {
        /* offline: keep what was read before */
      }
    }
    return this.versionInfo()
  }

  /* ------------------------------------------------ support ------------------------------------------------ */

  threadInfo(): support.ThreadInfo {
    const lic = this.opts.license
    const st = lic.status()
    const reg = lic.registration()
    const biz = this.businessInfo()
    return {
      deviceId: lic.deviceId,
      licenseId: st.payload?.licenseId ?? '',
      companyName: biz.companyName,
      contactName: reg?.ownerName || biz.ownerName,
      phone: reg?.phone || biz.firmPhone || ''
    }
  }

  private requireDb(): DB {
    const db = this.opts.getDb()
    if (!db) throw new AppError('The database is not open.', 'ERROR')
    return db
  }

  supportOverview(): Record<string, unknown> {
    const db = this.requireDb()
    const s = this.state.support
    return {
      online: this.online,
      messages: support.listMessages(db),
      counts: support.counts(db),
      background: this.opts.background !== false,
      sync: { lastSyncAt: s.lastSyncAt ?? null, lastOkAt: s.lastOkAt ?? null, ok: s.ok ?? null, offline: !!s.offline, error: s.error ?? null, warning: s.warning ?? null, syncing: !!this.syncInFlight },
      contact: this.threadInfo()
    }
  }

  queueSupport(input: { body: unknown; author: string; userId: number }): support.SupportMessage {
    const m = support.queueMessage(this.requireDb(), input)
    // Try to deliver right away (does not block the UI; failures keep the message queued).
    void this.syncSupport(true).catch(() => undefined)
    return m
  }

  retrySupport(uid: string): support.SupportMessage {
    const m = support.retryMessage(this.requireDb(), String(uid ?? ''))
    this.backoff.delete(m.uid)
    void this.syncSupport(true).catch(() => undefined)
    return m
  }

  markSupportRead(): number {
    const db = this.requireDb()
    const n = support.markAllRead(db)
    if (n > 0 || this.state.support.remoteUnread) {
      this.state.support.pendingRemoteRead = true
      this.save()
      void this.syncSupport(false).catch(() => undefined)
    }
    return n
  }

  /** One sync round (send queued, pull replies, report read). Concurrent calls share the running round. */
  syncSupport(force = false): Promise<support.SyncResult> {
    if (this.syncInFlight) {
      // A message queued during a running round must not wait for the next timer: run one more round after it.
      if (!this.nextRound) {
        this.nextRound = this.syncInFlight
          .catch(() => undefined)
          .then(() => {
            this.nextRound = null
            return this.syncSupport(force)
          })
      }
      return this.nextRound
    }
    this.syncInFlight = (async (): Promise<support.SyncResult> => {
      const db = this.requireDb()
      const s = this.state.support
      const client = this.opts.license.client
      let r: support.SyncResult
      if (!client) {
        r = { ok: false, offline: false, sent: 0, failed: 0, received: [], pending: support.counts(db).queued, error: 'Online features are not available in this build. Messages stay saved on this computer.' }
      } else {
        r = await support.syncSupport({ db, client, token: this.opts.license.installToken, thread: this.threadInfo(), state: s, backoff: this.backoff, force })
      }
      s.lastSyncAt = new Date().toISOString()
      s.ok = r.ok
      s.offline = r.offline
      s.error = r.error
      s.warning = r.warning ?? null
      if (r.ok) s.lastOkAt = s.lastSyncAt
      this.save()
      if (r.received.length) this.opts.onIncoming?.(r.received)
      if (r.sent || r.failed || r.received.length) this.opts.log?.('info', `Support sync: ${r.sent} sent, ${r.failed} failed, ${r.received.length} received`)
      return r
    })().finally(() => {
      this.syncInFlight = null
    })
    return this.syncInFlight
  }

  /* ------------------------------------------------ background ------------------------------------------------ */

  /** Heartbeat shortly after start-up and every 15 minutes; background support sync every 15 minutes. */
  start(opts: { heartbeatDelayMs?: number; supportDelayMs?: number } = {}): void {
    this.stop()
    if (this.opts.background === false) {
      this.opts.log?.('info', 'Automatic heartbeats and support sync are off in this development build (set DTSP_CLOUD_BACKGROUND=1 to enable).')
      return
    }
    const hb = (): void => void this.sendHeartbeat().catch(() => undefined)
    const sync = (): void => {
      if (!this.opts.getDb()) return
      void this.syncSupport(false).catch(() => undefined)
    }
    this.timers.push(setTimeout(hb, opts.heartbeatDelayMs ?? 5_000))
    this.timers.push(setInterval(hb, HEARTBEAT_EVERY_MS))
    this.timers.push(setTimeout(sync, opts.supportDelayMs ?? 40_000))
    this.timers.push(setInterval(sync, SUPPORT_BACKGROUND_EVERY_MS))
    for (const t of this.timers) (t as { unref?: () => void }).unref?.()
  }

  stop(): void {
    for (const t of this.timers) clearTimeout(t as ReturnType<typeof setTimeout>)
    this.timers = []
  }
}

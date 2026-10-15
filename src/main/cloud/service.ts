/**
 * Online features of one installation: device heartbeat (with consented location) and support messages.
 * Electron-free (unit and emulator tested); src/main/cloud/worker.ts wires it to the running app.
 */
import type { DB } from '../db'
import type { LicenseStatus, Registration } from '../license/types'
import { AppError, Ctx, audit, getSetting, setSetting } from '../services/context'
import type { FirestoreRest } from './firestore'
import { buildHeartbeat, heartbeatWrite, type HeartbeatPayload } from './heartbeat'
import { GEO_CACHE_MS, buildLocation, geoCacheFresh, lookupApproximate, normalizeMode, parseManualLocation, type HeartbeatLocation, type LocationMode } from './location'
import { maskToken } from './install'
import { loadCloudState, saveCloudState, type CloudState, type HeartbeatRecord } from './state'
import * as support from './support'

export const HEARTBEAT_EVERY_MS = 15 * 60_000
export const SUPPORT_BACKGROUND_EVERY_MS = 15 * 60_000
/** An approximate location older than this is not sent even when a refresh fails. */
const GEO_MAX_STALE_MS = 7 * GEO_CACHE_MS

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
  geoUrl?: string
  geoFetch?: NonNullable<Parameters<typeof lookupApproximate>[0]>['fetchImpl']
  onIncoming?: (msgs: support.IncomingMessage[]) => void
  log?: (level: 'info' | 'warn' | 'error', message: string) => void
}

export interface LocationInfo {
  mode: LocationMode
  manual: string
  manualError: string | null
  location: HeartbeatLocation | null
  /** Why no location is sent although sharing is on (lookup failed, invalid entry). */
  note: string | null
  geo: { label: string; fetchedAt: string } | null
  geoError: string | null
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

  get online(): boolean {
    return !!this.opts.license.client
  }

  /* ------------------------------------------------ business info ------------------------------------------------ */

  /** Active firm (signed-in user) or the default firm; registration company name before setup. */
  businessInfo(): { companyName: string; firmPhone: string; firms: number; users: number; ownerName: string } {
    const db = this.opts.getDb()
    const reg = this.opts.license.registration()
    let companyName = ''
    let firmPhone = ''
    let firms = 0
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
        users = (db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_active = 1').get() as { c: number }).c
        ownerName = session?.fullName || ((db.prepare('SELECT full_name FROM users WHERE is_owner = 1 ORDER BY id LIMIT 1').get() as { full_name: string } | undefined)?.full_name ?? '')
      } catch (e) {
        this.opts.log?.('warn', `Heartbeat: could not read business info: ${(e as Error).message}`)
      }
    }
    return { companyName: companyName || reg?.companyName || '', firmPhone, firms, users, ownerName: reg?.ownerName || ownerName }
  }

  /* ------------------------------------------------ location ------------------------------------------------ */

  locationSettings(): { mode: LocationMode; manual: string } {
    const db = this.opts.getDb()
    if (!db) return { mode: 'off', manual: '' }
    return { mode: normalizeMode(getSetting(db, 'location_sharing', 'off')), manual: String(getSetting(db, 'location_manual', '') ?? '') }
  }

  /** Resolves the location to send now. `lookup` = allowed to ask ipwho.is when the cache is stale. */
  async location(lookup = true): Promise<LocationInfo> {
    const { mode, manual } = this.locationSettings()
    const parsed = manual ? parseManualLocation(manual) : null
    const info: LocationInfo = {
      mode,
      manual,
      manualError: parsed && !parsed.ok ? parsed.error : null,
      location: null,
      note: null,
      geo: this.state.geo ? { label: this.state.geo.label, fetchedAt: this.state.geo.fetchedAt } : null,
      geoError: this.state.geoError
    }
    if (mode === 'approximate') {
      if (lookup && this.online && !geoCacheFresh(this.state.geo)) {
        try {
          this.state.geo = await lookupApproximate({ url: this.opts.geoUrl, fetchImpl: this.opts.geoFetch })
          this.state.geoError = null
        } catch (e) {
          this.state.geoError = (e as Error).message
        }
        this.save()
        info.geo = this.state.geo ? { label: this.state.geo.label, fetchedAt: this.state.geo.fetchedAt } : null
        info.geoError = this.state.geoError
      }
      const g = this.state.geo
      const usable = g && Date.now() - Date.parse(g.fetchedAt) < GEO_MAX_STALE_MS ? g : null
      info.location = buildLocation('approximate', { geo: usable })
      if (!info.location) info.note = this.state.geoError ? `Approximate location not available: ${this.state.geoError}` : 'The approximate location has not been looked up yet.'
    } else if (mode === 'manual') {
      if (!this.state.manual || this.state.manual.value !== manual) {
        this.state.manual = { value: manual, at: new Date().toISOString() }
        this.save()
      }
      info.location = buildLocation('manual', { manual, manualAt: this.state.manual.at })
      if (!info.location) info.note = info.manualError ?? 'Enter your coordinates to share your location.'
    }
    return info
  }

  /** Saves the customer's choice (consent). Turning sharing on requires a valid manual entry for "manual". */
  setLocation(ctx: Ctx, input: { mode: unknown; manual?: unknown }): LocationInfo['mode'] {
    const mode = normalizeMode(input.mode)
    if (input.mode !== undefined && !['off', 'approximate', 'manual'].includes(String(input.mode))) throw new AppError('Unknown location mode.', 'VALIDATION')
    const prev = this.locationSettings()
    let manual = prev.manual
    if (input.manual !== undefined) {
      manual = String(input.manual ?? '').trim()
      if (manual) {
        const p = parseManualLocation(manual)
        if (!p.ok) throw new AppError(p.error, 'VALIDATION')
      }
    }
    if (mode === 'manual' && !manual) throw new AppError('Enter your coordinates (latitude, longitude) to share an exact location.', 'VALIDATION')
    ctx.db.transaction(() => {
      setSetting(ctx.db, 'location_sharing', mode)
      setSetting(ctx.db, 'location_manual', manual.slice(0, 200))
    })()
    if (manual !== prev.manual) this.state.manual = manual ? { value: manual, at: new Date().toISOString() } : null
    if (mode !== 'approximate' && prev.mode === 'approximate') {
      // Forget the looked-up place when the customer withdraws consent.
      this.state.geo = null
      this.state.geoError = null
    }
    this.save()
    const label = { off: 'off', approximate: 'approximate (internet address)', manual: 'exact (entered manually)' }[mode]
    audit(ctx, 'update', 'settings', null, `Location sharing with Digital Target: ${label}`, { before: prev.mode, after: mode })
    return mode
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
      users: biz.users,
      location: loc.location
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
      installId: maskToken(this.opts.license.installToken),
      everyMinutes: HEARTBEAT_EVERY_MS / 60_000,
      location,
      preview: { documentId: `heartbeats/${maskToken(this.opts.license.installToken)}`, ...payload, lastSeen: '(server time)' },
      heartbeat: this.heartbeatRecord()
    }
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
      sync: { lastSyncAt: s.lastSyncAt ?? null, lastOkAt: s.lastOkAt ?? null, ok: s.ok ?? null, offline: !!s.offline, error: s.error ?? null, syncing: !!this.syncInFlight },
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

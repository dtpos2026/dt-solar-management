/**
 * Support messages to / from Digital Target with an offline queue.
 *
 * Local table support_messages (schema v2) is the source of truth on this computer:
 *   out: queued → sending → sent            (network problem: back to queued, nothing is lost)
 *                        ↘ failed (reason)   (refused by the service, or too many server errors) → retry → queued
 *   in:  received (admin replies pulled from Firestore; read_at set when the customer has seen them)
 *
 * Cloud (admin-panel/DATA_MODEL.md): supportThreads/{installToken} + messages/{uid}. The customer message id is the
 * local uid, so a retry after an unclear failure can never create a duplicate.
 */
import type { DB } from '../db'
import { FirestoreError, type FirestoreRest, type FsDocument, type Write } from './firestore'
import { randomToken } from './install'

export const SUPPORT_MAX_BODY = 4000
/** Server errors (5xx / 429) tolerated before a message is marked failed. Offline time never counts. */
export const MAX_SERVER_ATTEMPTS = 6

export type SupportStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'received'

export interface SupportMessage {
  id: number
  uid: string
  direction: 'out' | 'in'
  body: string
  author: string | null
  status: SupportStatus
  error: string | null
  attempts: number
  created_by: number | null
  created_at: string
  sent_at: string | null
  remote_at: string | null
  read_at: string | null
}

export class SupportError extends Error {
  code: string
  constructor(message: string, code = 'VALIDATION') {
    super(message)
    this.code = code
  }
}

export const OFFLINE_NOTE = 'Waiting for an internet connection — it will be sent automatically.'

/**
 * Firestore returns timestamps with a variable number of fraction digits ("…:05Z", "…:05.1Z", "…:05.123456Z"), which
 * do not sort as text. Every stored server time is normalised to 9 fraction digits so the pull cursor compares safely.
 */
export function normTs(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = v.trim().match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/)
  if (!m) return null
  if (m[3] !== 'Z') {
    const t = Date.parse(v)
    if (!Number.isFinite(t)) return null
    return normTs(new Date(t).toISOString())
  }
  return `${m[1]}.${(m[2] ?? '').padEnd(9, '0')}Z`
}

export function newMessageUid(): string {
  return randomToken(20)
}

export function cleanBody(body: unknown): string {
  const v = String(body ?? '').replace(/\r\n/g, '\n').trim()
  if (!v) throw new SupportError('Type a message first.')
  if (v.length > SUPPORT_MAX_BODY) throw new SupportError(`The message is too long (max ${SUPPORT_MAX_BODY} characters).`)
  return v
}

/** Stores a message locally first (status queued). It is visible immediately and sent by the sync worker. */
export function queueMessage(db: DB, input: { body: unknown; author?: string | null; userId?: number | null; uid?: string }): SupportMessage {
  const body = cleanBody(input.body)
  const uid = input.uid ?? newMessageUid()
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(uid)) throw new SupportError('Invalid message id.')
  db.prepare(`INSERT INTO support_messages (uid, direction, body, author, status, created_by) VALUES (?, 'out', ?, ?, 'queued', ?)`).run(
    uid,
    body,
    (input.author ?? '').slice(0, 120) || null,
    input.userId ?? null
  )
  return getMessage(db, uid)!
}

export function getMessage(db: DB, uid: string): SupportMessage | undefined {
  return db.prepare('SELECT * FROM support_messages WHERE uid = ?').get(uid) as SupportMessage | undefined
}

/** Conversation in display order (oldest first). Incoming messages are placed by server time. */
export function listMessages(db: DB, limit = 500): SupportMessage[] {
  const rows = db.prepare('SELECT * FROM support_messages ORDER BY id DESC LIMIT ?').all(Math.max(1, Math.min(5000, limit))) as SupportMessage[]
  return rows.sort((a, b) => sortKey(a) - sortKey(b) || a.id - b.id)
}

function sortKey(m: SupportMessage): number {
  if (m.direction === 'in' && m.remote_at) {
    const t = Date.parse(m.remote_at)
    if (Number.isFinite(t)) return t
  }
  // created_at is local time "YYYY-MM-DD HH:MM:SS"
  const t = Date.parse(String(m.created_at).replace(' ', 'T'))
  return Number.isFinite(t) ? t : 0
}

export function counts(db: DB): { unread: number; queued: number; failed: number; sending: number; total: number } {
  const r = db
    .prepare(
      `SELECT
        SUM(CASE WHEN direction = 'in' AND read_at IS NULL THEN 1 ELSE 0 END) AS unread,
        SUM(CASE WHEN direction = 'out' AND status = 'queued' THEN 1 ELSE 0 END) AS queued,
        SUM(CASE WHEN direction = 'out' AND status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN direction = 'out' AND status = 'sending' THEN 1 ELSE 0 END) AS sending,
        COUNT(*) AS total
       FROM support_messages`
    )
    .get() as Record<string, number | null>
  return { unread: r.unread ?? 0, queued: r.queued ?? 0, failed: r.failed ?? 0, sending: r.sending ?? 0, total: r.total ?? 0 }
}

/** Messages left in "sending" by an interrupted sync (app closed, crash) go back to the queue. */
export function recoverInterrupted(db: DB): number {
  return db.prepare(`UPDATE support_messages SET status = 'queued' WHERE direction = 'out' AND status = 'sending'`).run().changes
}

/** queued → sending. Returns false when the message is not (or no longer) queued. */
export function claim(db: DB, uid: string): boolean {
  return db.prepare(`UPDATE support_messages SET status = 'sending' WHERE uid = ? AND direction = 'out' AND status = 'queued'`).run(uid).changes === 1
}

export function markSent(db: DB, uid: string, remoteAt?: string | null): void {
  db.prepare(
    `UPDATE support_messages SET status = 'sent', error = NULL, sent_at = datetime('now','localtime'), remote_at = COALESCE(?, remote_at), attempts = attempts + 1
     WHERE uid = ? AND direction = 'out' AND status IN ('sending','queued','failed')`
  ).run(normTs(remoteAt), uid)
}

/** Back to the queue with a visible note. `countAttempt` = a real server error (offline time is not counted). */
export function markRetry(db: DB, uid: string, note: string, countAttempt: boolean): SupportMessage | undefined {
  db.prepare(
    `UPDATE support_messages SET status = 'queued', error = ?, attempts = attempts + ? WHERE uid = ? AND direction = 'out' AND status IN ('sending','queued')`
  ).run(note.slice(0, 300), countAttempt ? 1 : 0, uid)
  return getMessage(db, uid)
}

export function markFailed(db: DB, uid: string, reason: string): void {
  db.prepare(`UPDATE support_messages SET status = 'failed', error = ?, attempts = attempts + 1 WHERE uid = ? AND direction = 'out' AND status IN ('sending','queued')`).run(
    reason.slice(0, 300),
    uid
  )
}

/** failed → queued (user pressed Retry). Sent messages cannot be re-sent. */
export function retryMessage(db: DB, uid: string): SupportMessage {
  const m = getMessage(db, uid)
  if (!m || m.direction !== 'out') throw new SupportError('Message not found.', 'NOT_FOUND')
  if (m.status === 'sent') throw new SupportError('This message has already been sent.')
  if (m.status === 'failed' || m.status === 'queued') {
    db.prepare(`UPDATE support_messages SET status = 'queued', error = NULL, attempts = 0 WHERE uid = ?`).run(uid)
  }
  return getMessage(db, uid)!
}

export interface IncomingMessage {
  uid: string
  body: string
  author: string | null
  at: string
}

/** Stores admin replies. Idempotent: a message already stored (same uid) is ignored. Returns the new ones. */
export function ingestIncoming(db: DB, msgs: IncomingMessage[]): IncomingMessage[] {
  const ins = db.prepare(`INSERT OR IGNORE INTO support_messages (uid, direction, body, author, status, remote_at) VALUES (?, 'in', ?, ?, 'received', ?)`)
  const added: IncomingMessage[] = []
  db.transaction(() => {
    for (const m of msgs) {
      if (!m.uid || !m.body) continue
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(m.uid)) continue
      if (ins.run(m.uid, String(m.body).slice(0, SUPPORT_MAX_BODY), m.author ? String(m.author).slice(0, 120) : null, normTs(m.at)).changes === 1) added.push(m)
    }
  })()
  return added
}

export function markAllRead(db: DB): number {
  return db.prepare(`UPDATE support_messages SET read_at = datetime('now','localtime') WHERE direction = 'in' AND read_at IS NULL`).run().changes
}

/** Server time of the newest admin reply already stored (pull cursor). */
export function lastIncomingAt(db: DB): string | null {
  const r = db.prepare(`SELECT remote_at FROM support_messages WHERE direction = 'in' AND remote_at IS NOT NULL ORDER BY remote_at DESC LIMIT 1`).get() as
    | { remote_at: string }
    | undefined
  return r?.remote_at ?? null
}

/* ------------------------------------------------ cloud sync ------------------------------------------------ */

export interface ThreadInfo {
  deviceId: string
  licenseId: string
  companyName: string
  contactName: string
  phone: string
}

export interface SyncState {
  /** updateTime of the thread document at the last successful pull. */
  pulledThreadUpdate?: string | null
  /** The thread had unread replies for the customer at the last check. */
  remoteUnread?: boolean
  /** "Read" has to be reported to the cloud at the next sync. */
  pendingRemoteRead?: boolean
}

export interface SyncResult {
  ok: boolean
  offline: boolean
  sent: number
  failed: number
  received: IncomingMessage[]
  pending: number
  error: string | null
  /** Delivered, but with a side note (e.g. the thread summary could not be updated). */
  warning?: string | null
}

export interface SyncDeps {
  db: DB
  client: FirestoreRest
  token: string
  thread: ThreadInfo
  state: SyncState
  /** uid → earliest next attempt (ms). Respected unless `force`. */
  backoff: Map<string, number>
  force?: boolean
  now?: () => number
}

const cut = (v: unknown, max: number): string => String(v ?? '').slice(0, max)

export function backoffMs(attempts: number): number {
  return Math.min(30 * 60_000, 30_000 * Math.pow(2, Math.max(0, attempts - 1)))
}

export function threadWrite(token: string, t: ThreadInfo, body: string, exists: boolean): Write {
  const common = {
    companyName: cut(t.companyName, 200),
    contactName: cut(t.contactName, 200),
    phone: cut(t.phone, 60),
    licenseId: cut(t.licenseId, 64),
    status: 'open',
    lastMessageFrom: 'customer',
    lastMessagePreview: cut(body.replace(/\s+/g, ' '), 200),
    unreadByAdmin: true
  }
  if (exists) {
    return { path: `supportThreads/${token}`, fields: common, mask: Object.keys(common), serverTime: ['lastMessageAt'], exists: true }
  }
  return {
    path: `supportThreads/${token}`,
    fields: { deviceId: cut(t.deviceId, 64), ...common, unreadByCustomer: false },
    serverTime: ['lastMessageAt', 'createdAt'],
    exists: false
  }
}

export function messageWrite(token: string, m: Pick<SupportMessage, 'uid' | 'body' | 'author'>): Write {
  return {
    path: `supportThreads/${token}/messages/${m.uid}`,
    fields: { from: 'customer', body: m.body, authorName: cut(m.author ?? '', 120) },
    serverTime: ['at'],
    exists: false
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Admin replies newer than the pull cursor (structured query on the thread's messages, ordered by server time). */
export function repliesQuery(since: string | null): Record<string, unknown> {
  return {
    from: [{ collectionId: 'messages' }],
    ...(since ? { where: { fieldFilter: { field: { fieldPath: 'at' }, op: 'GREATER_THAN', value: { timestampValue: since } } } } : {}),
    orderBy: [{ field: { fieldPath: 'at' }, direction: 'ASCENDING' }],
    limit: 300
  }
}

/**
 * One sync round: sends queued messages (oldest first), pulls admin replies, reports "read".
 * Never throws for network problems — the result says what happened.
 */
export async function syncSupport(d: SyncDeps): Promise<SyncResult> {
  const now = d.now ?? Date.now
  const res: SyncResult = { ok: true, offline: false, sent: 0, failed: 0, received: [], pending: 0, error: null, warning: null }
  recoverInterrupted(d.db)
  const queued = d.db.prepare(`SELECT * FROM support_messages WHERE direction = 'out' AND status = 'queued' ORDER BY id`).all() as SupportMessage[]
  const threadPath = `supportThreads/${d.token}`

  let thread: FsDocument | null
  try {
    thread = await d.client.get(threadPath)
  } catch (e) {
    const offline = e instanceof FirestoreError && e.offline
    for (const m of queued) markRetry(d.db, m.uid, offline ? OFFLINE_NOTE : `${describe(e)} It will be retried automatically.`, false)
    res.ok = false
    res.offline = offline
    res.error = describe(e)
    res.pending = queued.length
    return res
  }
  let threadExists = !!thread

  /* ---------- send ---------- */
  for (const m of queued) {
    if (!d.force && (d.backoff.get(m.uid) ?? 0) > now()) {
      res.pending++
      continue
    }
    if (!claim(d.db, m.uid)) continue
    let retried = false
    for (;;) {
      try {
        // REQUEST_TIME is the commit time, so commitTime is exactly the message's server timestamp.
        const r = await d.client.commit([threadWrite(d.token, d.thread, m.body, threadExists), messageWrite(d.token, m)])
        markSent(d.db, m.uid, r.commitTime ?? null)
        d.backoff.delete(m.uid)
        threadExists = true
        res.sent++
        break
      } catch (e) {
        const fe = e instanceof FirestoreError ? e : null
        if (fe?.offline) {
          markRetry(d.db, m.uid, OFFLINE_NOTE, false)
          res.ok = false
          res.offline = true
          res.error = fe.message
          res.pending++
          break
        }
        // Was it delivered after all (e.g. an earlier attempt timed out after the server stored it)? → sent.
        const existing = await d.client.get(`${threadPath}/messages/${m.uid}`).catch(() => undefined)
        if (existing) {
          markSent(d.db, m.uid, (existing.data.at as string | undefined) ?? null)
          d.backoff.delete(m.uid)
          threadExists = true
          res.sent++
          break
        }
        // The thread was created / deleted meanwhile → retry once with the right create-or-update form.
        if (!retried && existing === null) {
          const fresh = await d.client.get(threadPath).catch(() => undefined)
          if (fresh !== undefined && !!fresh !== threadExists) {
            threadExists = !!fresh
            retried = true
            continue
          }
          // The thread summary itself was refused (e.g. the thread holds fields the customer may not keep):
          // the message is what matters — deliver it on its own.
          if (fe?.code === 'PERMISSION_DENIED' && fresh) {
            try {
              const r = await d.client.commit([messageWrite(d.token, m)])
              markSent(d.db, m.uid, r.commitTime ?? null)
              d.backoff.delete(m.uid)
              res.sent++
              res.warning = 'The message was delivered, but the conversation summary could not be updated.'
              break
            } catch {
              /* fall through: report the original error */
            }
          }
        }
        if (fe?.transient || existing === undefined) {
          const after = markRetry(d.db, m.uid, `${describe(e)} Retrying automatically.`, true)
          const attempts = after?.attempts ?? 1
          if (attempts >= MAX_SERVER_ATTEMPTS) {
            d.db.prepare(`UPDATE support_messages SET status = 'failed', error = ? WHERE uid = ?`).run(`Could not be delivered after ${attempts} attempts: ${describe(e)}`.slice(0, 300), m.uid)
            res.failed++
          } else {
            d.backoff.set(m.uid, now() + backoffMs(attempts))
            res.pending++
          }
        } else {
          markFailed(d.db, m.uid, describe(e))
          res.failed++
        }
        res.ok = false
        res.error = describe(e)
        break
      }
    }
    if (res.offline) {
      // No point trying the rest now; keep them queued with the offline note.
      for (const rest of queued) {
        const cur = getMessage(d.db, rest.uid)
        if (cur?.status === 'queued' && rest.uid !== m.uid) markRetry(d.db, rest.uid, OFFLINE_NOTE, false)
      }
      res.pending = counts(d.db).queued
      return res
    }
  }

  /* ---------- pull admin replies (always: an empty result costs one read) ---------- */
  try {
    const docs = await d.client.runQuery(threadPath, repliesQuery(lastIncomingAt(d.db)))
    const incoming = docs
      .filter((doc) => doc.data.from === 'admin' && typeof doc.data.body === 'string' && String(doc.data.body).trim())
      .map((doc) => ({ uid: doc.id, body: String(doc.data.body), author: (doc.data.authorName as string) || 'Digital Target', at: String(doc.data.at ?? '') }))
    res.received = ingestIncoming(d.db, incoming)
    if (threadExists) {
      if (res.sent > 0 || res.received.length > 0) thread = await d.client.get(threadPath)
      d.state.remoteUnread = thread?.data.unreadByCustomer === true
      d.state.pulledThreadUpdate = thread?.updateTime ?? null
      /* ---------- report "read" ---------- */
      if (d.state.pendingRemoteRead && counts(d.db).unread === 0) {
        if (thread?.data.unreadByCustomer === true) {
          await d.client.commit([{ path: threadPath, fields: { unreadByCustomer: false }, mask: ['unreadByCustomer'], exists: true }])
        }
        d.state.pendingRemoteRead = false
        d.state.remoteUnread = false
      }
    }
  } catch (e) {
    res.ok = false
    res.offline = e instanceof FirestoreError && e.offline
    res.error = describe(e)
  }
  res.pending = counts(d.db).queued
  return res
}

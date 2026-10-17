/**
 * Firestore access for clients/{clientId} (companies). Pure helpers live in clients.ts.
 * Client codes come from counters/clients (transaction). Every change writes an audit entry (category client).
 */
import {
  Timestamp,
  collection,
  doc,
  getDocs,
  limit,
  query,
  runTransaction,
  serverTimestamp,
  where,
  writeBatch,
  type DocumentData,
  type DocumentSnapshot,
  type QueryDocumentSnapshot,
  type Transaction
} from 'firebase/firestore'
import { db } from '../firebase'
import {
  clientDeleteCheck,
  clientDetailsFromLicense,
  clientFromLicense,
  findDuplicateClient,
  formatClientCode,
  isActiveLicense,
  missingClientFields,
  validateClient,
  type ClientDeleteCheck,
  type ClientInput,
  type ClientStatus
} from './clients'
import {
  invalidateLicenses,
  licenseFromSnap,
  licenseRef,
  licenseStatusPatch,
  licenseStatusRef,
  licensesCol,
  writeAuditEntry,
  writeLog,
  type ClientLinker,
  type LicenseInput
} from './licenses'
import { loadThreads } from './fleet'
import { fromInputDate, toInputDate } from './format'
import { invalidate } from './queryCache'
import type { Client, License, PlanType } from './types'

export const clientsCol = () => collection(db, 'clients')
export const clientRef = (id: string) => doc(db, 'clients', id)
const counterRef = () => doc(db, 'counters', 'clients')

type Snap = DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData>
const s = (v: unknown) => (typeof v === 'string' ? v : '')
const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const t = (v: unknown) => (v instanceof Timestamp ? v : null)

export function clientFromSnap(snap: Snap): Client {
  const d = snap.data() ?? {}
  return {
    id: snap.id,
    code: s(d.code),
    company: s(d.company),
    ownerName: s(d.ownerName),
    phone: s(d.phone),
    email: s(d.email),
    address: s(d.address),
    city: s(d.city),
    logo: typeof d.logo === 'string' && d.logo ? d.logo : null,
    status: (['active', 'suspended', 'archived'].includes(d.status) ? d.status : 'active') as Client['status'],
    plan: s(d.plan),
    planType: (['monthly', 'yearly', 'lifetime'].includes(d.planType) ? d.planType : 'yearly') as PlanType,
    allowedFirms: n(d.allowedFirms, 1),
    allowedDevices: n(d.allowedDevices, 1),
    notes: s(d.notes),
    registeredAt: t(d.registeredAt),
    createdAt: t(d.createdAt),
    updatedAt: t(d.updatedAt),
    createdBy: s(d.createdBy)
  }
}

export function clientToInput(c: Client): ClientInput {
  return {
    company: c.company,
    ownerName: c.ownerName,
    phone: c.phone,
    email: c.email,
    address: c.address,
    city: c.city,
    logo: c.logo,
    status: c.status,
    plan: c.plan,
    planType: c.planType,
    allowedFirms: c.allowedFirms,
    allowedDevices: c.allowedDevices,
    notes: c.notes,
    registeredAt: c.registeredAt ? toInputDate(c.registeredAt.toDate()) : ''
  }
}

function cleanClient(i: ClientInput) {
  const errors = validateClient(i)
  const first = Object.values(errors)[0]
  if (first) throw new Error(first)
  const reg = fromInputDate(i.registeredAt)
  return {
    company: i.company.trim(),
    ownerName: i.ownerName.trim(),
    phone: i.phone.trim(),
    email: i.email.trim(),
    address: i.address.trim(),
    city: i.city.trim(),
    logo: i.logo || null,
    status: i.status,
    plan: i.plan,
    planType: i.planType,
    allowedFirms: i.allowedFirms,
    allowedDevices: i.allowedDevices,
    notes: i.notes.trim(),
    registeredAt: reg ? Timestamp.fromDate(new Date(reg.getFullYear(), reg.getMonth(), reg.getDate())) : null
  }
}

/** Creates a client with the next code from counters/clients. Optionally links a license in the same transaction. */
/** Takes the next client code from counters/clients and writes the client + its audit entry (reads first). */
async function createClientInTx(tx: Transaction, data: ReturnType<typeof cleanClient>, by: string, note = ''): Promise<{ id: string; code: string }> {
  const ref = doc(clientsCol())
  const c = await tx.get(counterRef())
  const next = c.exists() ? Math.max(1, Math.floor(Number(c.data()?.next) || 1)) : 1
  const code = formatClientCode(next)
  tx.set(counterRef(), { next: next + 1 }, { merge: true })
  tx.set(ref, {
    ...data,
    code,
    registeredAt: data.registeredAt ?? serverTimestamp(),
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    createdBy: by
  })
  writeAuditEntry(tx, { action: 'client_created', category: 'client', by, target: ref.id, targetType: 'client', details: `${code} ${data.company}${data.city ? ` (${data.city})` : ''}${note}` })
  return { id: ref.id, code }
}

export async function createClient(input: ClientInput, by: string, link?: { license: License; reason?: string }): Promise<{ id: string; code: string }> {
  const data = cleanClient(input)
  const r = await runTransaction(db, async (tx) => {
    const { id, code } = await createClientInTx(tx, data, by)
    const ref = clientRef(id)
    if (link) {
      tx.update(licenseRef(link.license.id), { clientId: ref.id, updatedAt: serverTimestamp() })
      writeLog(tx, link.license.id, 'client_linked', by, `License linked to new client ${code} ${data.company}${link.reason ? ` - ${link.reason}` : ''}`, 'client')
    }
    return { id, code }
  })
  invalidate('clients')
  return r
}

export async function updateClient(c: Client, input: ClientInput, by: string): Promise<void> {
  const data = cleanClient(input)
  const before = clientToInput(c)
  const changes: string[] = []
  for (const k of Object.keys(data) as (keyof typeof data)[]) {
    if (k === 'registeredAt') {
      if (before.registeredAt !== input.registeredAt) changes.push(`registered ${before.registeredAt || '-'} → ${input.registeredAt || '-'}`)
      continue
    }
    if (k === 'logo') {
      if ((before.logo ?? null) !== data.logo) changes.push('logo updated')
      continue
    }
    if (k === 'notes') {
      if (before.notes.trim() !== data.notes) changes.push('notes updated')
      continue
    }
    const a = (before as unknown as Record<string, unknown>)[k]
    const b = (data as unknown as Record<string, unknown>)[k]
    if (String(a ?? '') !== String(b ?? '')) changes.push(`${k}: ${String(a ?? '') || '-'} → ${String(b ?? '') || '-'}`)
  }
  const batch = writeBatch(db)
  batch.update(clientRef(c.id), { ...data, updatedAt: serverTimestamp() })
  writeAuditEntry(batch, { action: 'client_updated', category: 'client', by, target: c.id, targetType: 'client', details: `${c.code} ${data.company}: ${changes.join('; ') || 'no changes'}` })
  await batch.commit()
}

/**
 * Suspends / reactivates / archives a client. Optionally applies the same to its licenses
 * (suspend: active → suspended; reactivate: suspended → active). Detached licenses are never touched.
 */
export async function setClientStatus(c: Client, status: ClientStatus, reason: string, by: string, licenses: License[] = []): Promise<number> {
  if (status === c.status) throw new Error(`The client is already ${status}.`)
  const batch = writeBatch(db)
  batch.update(clientRef(c.id), { status, updatedAt: serverTimestamp() })
  const action = status === 'active' ? 'client_reactivated' : status === 'suspended' ? 'client_suspended' : 'client_archived'
  let touched = 0
  for (const l of licenses) {
    if (l.detached) continue
    const to = status === 'active' ? 'active' : 'suspended'
    if ((to === 'suspended' && l.status !== 'active') || (to === 'active' && l.status !== 'suspended')) continue
    batch.update(licenseRef(l.id), { status: to, updatedAt: serverTimestamp() })
    batch.set(licenseStatusRef(l.id), licenseStatusPatch({ ...l, status: to }), { merge: true })
    writeLog(batch, l.id, to === 'active' ? 'license_reactivated' : 'license_suspended', by, `Status ${l.status} → ${to} with client ${c.code}${reason.trim() ? `. Reason: ${reason.trim()}` : ''}`)
    touched++
  }
  writeAuditEntry(batch, {
    action,
    category: 'client',
    by,
    target: c.id,
    targetType: 'client',
    details: `${c.code} ${c.company}: ${c.status} → ${status}${touched ? `; ${touched} license(s) ${status === 'active' ? 'reactivated' : 'suspended'}` : ''}${reason.trim() ? `. Reason: ${reason.trim()}` : ''}`
  })
  await batch.commit()
  return touched
}

/** Counts what references the client (licenses always; invoices / threads only when the admin may read them). */
export async function clientLinks(clientId: string, licenseIds: string[], opts: { invoices: boolean; threads: boolean }): Promise<{ licenses: number; invoices: number; threads: number }> {
  const lic = await getDocs(query(licensesCol(), where('clientId', '==', clientId), limit(1)))
  let invoices = 0
  let threads = 0
  if (opts.invoices) invoices = (await getDocs(query(collection(db, 'invoices'), where('clientId', '==', clientId), limit(1)))).size
  if (opts.threads && licenseIds.length) {
    threads = (await getDocs(query(collection(db, 'supportThreads'), where('licenseId', 'in', licenseIds.slice(0, 30)), limit(1)))).size
  }
  return { licenses: lic.size, invoices, threads }
}

export interface ClientDeleteOptions {
  /** clients.manage */
  canDelete: boolean
  /** licenses.manage / licenses.generate / devices.manage (may change license.clientId) */
  canUnlink: boolean
  /** The admin may read invoices / support threads. */
  invoices: boolean
  threads: boolean
}
export interface ClientDeletePreview {
  licenses: License[]
  invoices: number | null
  openInvoices: number
  threads: number
  check: ClientDeleteCheck
}

/** Fresh look at everything linked to the client and whether it may be deleted now (see clientDeleteCheck). */
export async function clientDeletePreview(c: Client, o: ClientDeleteOptions): Promise<ClientDeletePreview> {
  const licenses = await loadClientLicenses(c.id)
  let invoices: number | null = null
  let openInvoices = 0
  if (o.invoices) {
    const snap = await getDocs(query(collection(db, 'invoices'), where('clientId', '==', c.id)))
    invoices = snap.size
    openInvoices = snap.docs.filter((d) => d.data().status !== 'cancelled' && Number(d.data().balance) > 0.005).length
  }
  const threads = o.threads && licenses.length ? (await loadThreads(licenses.map((l) => l.id))).length : 0
  const check = clientDeleteCheck({
    canDelete: o.canDelete,
    canUnlink: o.canUnlink,
    licenses: licenses.map((l) => ({ id: l.id, licenseKey: l.licenseKey, status: l.status, expiresAtMs: l.expiresAt ? l.expiresAt.toMillis() : null })),
    invoices,
    openInvoices,
    threads
  })
  return { licenses, invoices, openInvoices, threads, check }
}

/** Licenses unlinked per transaction (3 writes each: license, history, audit). */
const UNLINK_PER_TX = 120

/**
 * Hard delete of a client (clients.manage). Re-checks the links first: refused while an active license is linked;
 * suspended / revoked / expired licenses are unlinked (history + audit on each), then the client document is deleted
 * with a 'client_deleted' audit entry in the same transaction. Invoices and support threads are kept.
 */
export async function deleteClient(c: Client, by: string, o: ClientDeleteOptions): Promise<{ unlinked: number }> {
  const prev = await clientDeletePreview(c, o)
  if (!prev.check.ok) throw new Error(prev.check.blockers.join(' '))
  const ids = prev.check.unlink
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += UNLINK_PER_TX) chunks.push(ids.slice(i, i + UNLINK_PER_TX))
  if (!chunks.length) chunks.push([])
  let unlinked = 0
  for (let i = 0; i < chunks.length; i++) {
    const last = i === chunks.length - 1
    const done = unlinked
    unlinked += await runTransaction(db, async (tx) => {
      const cs = await tx.get(clientRef(c.id))
      if (!cs.exists()) throw new Error('This client no longer exists (deleted by another admin?).')
      const snaps = await Promise.all(chunks[i].map((id) => tx.get(licenseRef(id))))
      let n = 0
      for (const s of snaps) {
        if (!s.exists()) continue
        const l = licenseFromSnap(s)
        if (l.clientId !== c.id) continue
        if (isActiveLicense({ status: l.status, expiresAtMs: l.expiresAt ? l.expiresAt.toMillis() : null })) {
          throw new Error(`License ${l.licenseKey} was reactivated in the meantime, so the client was not deleted. Check the client again.`)
        }
        tx.update(licenseRef(l.id), { clientId: '', updatedAt: serverTimestamp() })
        writeLog(tx, l.id, 'client_unlinked', by, `License unlinked from client ${c.code} ${c.company} (client deleted)`, 'client')
        n++
      }
      if (last) {
        tx.delete(clientRef(c.id))
        const total = done + n
        writeAuditEntry(tx, {
          action: 'client_deleted',
          category: 'client',
          by,
          target: c.id,
          targetType: 'client',
          details: `${c.code} ${c.company} permanently deleted${total ? `; ${total} license(s) unlinked` : ''}${prev.invoices ? `; ${prev.invoices} invoice(s) kept` : ''}`,
          meta: { code: c.code, company: c.company, unlinked: total, invoices: prev.invoices }
        })
      }
      return n
    })
  }
  invalidate('clients')
  invalidateLicenses()
  return { unlinked }
}

/** Unlinks licenses from a client (the delete dialog offers it for active licenses, which then stay client-less). */
export async function unlinkClientLicenses(c: Client, licenseIds: string[], by: string): Promise<number> {
  let n = 0
  for (let i = 0; i < licenseIds.length; i += UNLINK_PER_TX) {
    const part = licenseIds.slice(i, i + UNLINK_PER_TX)
    n += await runTransaction(db, async (tx) => {
      const snaps = await Promise.all(part.map((id) => tx.get(licenseRef(id))))
      let k = 0
      for (const s of snaps) {
        if (!s.exists() || s.data()?.clientId !== c.id) continue
        tx.update(licenseRef(s.id), { clientId: '', updatedAt: serverTimestamp() })
        writeLog(tx, s.id, 'client_unlinked', by, `License unlinked from client ${c.code} ${c.company}`, 'client')
        k++
      }
      return k
    })
  }
  invalidateLicenses()
  return n
}

/* ------------------------------------------- license -> client sync ------------------------------------------- */

export interface ClientSync {
  /** picked = the client chosen in the form; matched = same phone / company + owner; new = created on save */
  kind: 'picked' | 'matched' | 'new'
  /** How an existing client was matched. */
  by?: 'phone' | 'name'
  client: Client | null
  linker: ClientLinker
}

/**
 * Decides which client a license's details belong to (no duplicates): the picked client, else an existing client
 * with the same phone (digits only, last 10) or the same company + owner name, else a new client with the next code.
 * The returned linker runs inside the license transaction: an existing client only gets its EMPTY fields filled
 * from the license (never overwritten); a new client is created from the license details.
 * `candidates` = all clients (read fresh when omitted).
 */
export async function clientSyncFor(input: LicenseInput, by: string, candidates?: Client[]): Promise<ClientSync> {
  const all = candidates ?? (await loadClients())
  const details = clientDetailsFromLicense(input)
  const picked = input.clientId ? all.find((c) => c.id === input.clientId) ?? null : null
  const match = picked ? null : findDuplicateClient(all, details)
  const target = picked ?? match?.client ?? null
  if (target) {
    const id = target.id
    return {
      kind: picked ? 'picked' : 'matched',
      by: match?.by,
      client: target,
      linker: async (tx) => {
        const snap = await tx.get(clientRef(id))
        if (!snap.exists()) throw new Error('The client was deleted in the meantime. Choose another client or save again.')
        const cur = clientFromSnap(snap)
        const patch = missingClientFields(cur, details)
        const keys = Object.keys(patch)
        if (keys.length) {
          tx.update(clientRef(id), { ...patch, updatedAt: serverTimestamp() })
          writeAuditEntry(tx, { action: 'client_updated', category: 'client', by, target: id, targetType: 'client', details: `${cur.code} ${cur.company}: filled from license details (${keys.join(', ')})` })
        }
        return { clientId: id, label: `${cur.code} ${cur.company}`, created: false }
      }
    }
  }
  const data = cleanClient(
    clientFromLicense({
      businessName: input.businessName,
      customerName: input.customerName,
      phone: input.phone,
      email: input.email,
      city: input.city,
      plan: input.plan,
      planType: input.planType ?? (input.expiresAt ? 'yearly' : 'lifetime'),
      maxFirms: input.maxFirms,
      maxDevices: input.maxDevices
    })
  )
  return {
    kind: 'new',
    client: null,
    linker: async (tx) => {
      const { id, code } = await createClientInTx(tx, data, by, ' (created from license details)')
      return { clientId: id, label: `${code} ${data.company}`, created: true }
    }
  }
}

export async function loadClients(): Promise<Client[]> {
  const snap = await getDocs(clientsCol())
  return snap.docs.map(clientFromSnap).sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0))
}

export async function loadClientLicenses(clientId: string): Promise<License[]> {
  const snap = await getDocs(query(licensesCol(), where('clientId', '==', clientId)))
  return snap.docs.map(licenseFromSnap).sort((a, b) => (b.createdAt?.toMillis() ?? 0) - (a.createdAt?.toMillis() ?? 0))
}

/**
 * Downscales an image file to at most `maxSide` px and encodes it as a data URL ≤ maxBytes
 * (WebP/JPEG with decreasing quality; PNG kept for small images with transparency).
 */
export async function compressLogo(file: File, maxBytes = 200 * 1024, maxSide = 320): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif|bmp|svg\+xml)$/.test(file.type)) throw new Error('Choose a PNG, JPEG or WebP image.')
  const url = URL.createObjectURL(file)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image()
      i.onload = () => resolve(i)
      i.onerror = () => reject(new Error('This image could not be read.'))
      i.src = url
    })
    let side = maxSide
    for (let attempt = 0; attempt < 6; attempt++) {
      const scale = Math.min(1, side / Math.max(img.naturalWidth || side, img.naturalHeight || side))
      const w = Math.max(1, Math.round((img.naturalWidth || side) * scale))
      const h = Math.max(1, Math.round((img.naturalHeight || side) * scale))
      const canvas = document.createElement('canvas')
      canvas.width = w
      canvas.height = h
      const ctx = canvas.getContext('2d')
      if (!ctx) throw new Error('Image compression is not available in this browser.')
      ctx.drawImage(img, 0, 0, w, h)
      const png = canvas.toDataURL('image/png')
      if (png.length * 0.75 <= maxBytes) return png
      for (const q of [0.9, 0.8, 0.7, 0.6, 0.5]) {
        let out = canvas.toDataURL('image/webp', q)
        if (!out.startsWith('data:image/webp')) out = canvas.toDataURL('image/jpeg', q)
        if (out.length * 0.75 <= maxBytes) return out
      }
      side = Math.round(side * 0.7)
    }
    throw new Error('The logo is too large even after compression. Use a smaller image.')
  } finally {
    URL.revokeObjectURL(url)
  }
}

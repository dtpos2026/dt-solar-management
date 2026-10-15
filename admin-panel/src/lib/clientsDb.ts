/**
 * Firestore access for clients/{clientId} (companies). Pure helpers live in clients.ts.
 * Client codes come from counters/clients (transaction). Every change writes an audit entry (category client).
 */
import {
  Timestamp,
  collection,
  deleteDoc,
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
  type QueryDocumentSnapshot
} from 'firebase/firestore'
import { db } from '../firebase'
import { formatClientCode, hardDeleteGuard, validateClient, type ClientInput, type ClientStatus } from './clients'
import { licenseFromSnap, licenseRef, licenseStatusPatch, licenseStatusRef, licensesCol, writeAuditEntry, writeLog } from './licenses'
import { fromInputDate, toInputDate } from './format'
import type { Client, License, PlanType } from './types'
import { logActivity } from './audit'

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
export async function createClient(input: ClientInput, by: string, link?: { license: License; reason?: string }): Promise<{ id: string; code: string }> {
  const data = cleanClient(input)
  const ref = doc(clientsCol())
  const code = await runTransaction(db, async (tx) => {
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
    writeAuditEntry(tx, { action: 'client_created', category: 'client', by, target: ref.id, targetType: 'client', details: `${code} ${data.company}${data.city ? ` (${data.city})` : ''}` })
    if (link) {
      tx.update(licenseRef(link.license.id), { clientId: ref.id, updatedAt: serverTimestamp() })
      writeLog(tx, link.license.id, 'client_linked', by, `License linked to new client ${code} ${data.company}${link.reason ? ` — ${link.reason}` : ''}`, 'client')
    }
    return code
  })
  return { id: ref.id, code }
}

export async function updateClient(c: Client, input: ClientInput, by: string): Promise<void> {
  const data = cleanClient(input)
  const before = clientToInput(c)
  const changes: string[] = []
  for (const k of Object.keys(data) as (keyof typeof data)[]) {
    if (k === 'registeredAt') {
      if (before.registeredAt !== input.registeredAt) changes.push(`registered ${before.registeredAt || '—'} → ${input.registeredAt || '—'}`)
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
    if (String(a ?? '') !== String(b ?? '')) changes.push(`${k}: ${String(a ?? '') || '—'} → ${String(b ?? '') || '—'}`)
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

/** Owner-only hard delete, only when nothing links to the client (the rules allow owners only). */
export async function deleteClient(c: Client, by: string, isOwner: boolean): Promise<void> {
  const links = await clientLinks(c.id, [], { invoices: true, threads: false })
  const g = hardDeleteGuard({ isOwner, linkedLicenses: links.licenses, linkedInvoices: links.invoices })
  if (!g.ok) throw new Error(g.reason)
  await deleteDoc(clientRef(c.id))
  await logActivity({ action: 'client_deleted', category: 'client', target: c.id, targetType: 'client', details: `${c.code} ${c.company} permanently deleted by ${by}` })
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

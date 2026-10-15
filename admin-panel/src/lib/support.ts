/** Support conversations (supportThreads/{installToken} + messages). Only the DATA_MODEL.md thread fields are written. */
import { Timestamp, collection, doc, serverTimestamp, updateDoc, writeBatch, type DocumentData, type DocumentSnapshot, type QueryDocumentSnapshot, type WriteBatch } from 'firebase/firestore'
import { auth, db } from '../firebase'
import { auditCol } from './licenses'
import type { SupportMessage, SupportThread } from './types'

type Snap = DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData>
const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const ts = (v: unknown): Timestamp | null => (v instanceof Timestamp ? v : null)

export const threadsCol = () => collection(db, 'supportThreads')
export const threadRef = (id: string) => doc(db, 'supportThreads', id)
export const messagesCol = (id: string) => collection(db, 'supportThreads', id, 'messages')

export function threadFromSnap(x: Snap): SupportThread {
  const d = x.data() ?? {}
  return {
    id: x.id, deviceId: s(d.deviceId), licenseId: s(d.licenseId), companyName: s(d.companyName), contactName: s(d.contactName), phone: s(d.phone),
    status: (['open', 'pending', 'resolved'].includes(d.status) ? d.status : 'open') as SupportThread['status'],
    lastMessageAt: ts(d.lastMessageAt), lastMessageFrom: d.lastMessageFrom === 'admin' ? 'admin' : 'customer', lastMessagePreview: s(d.lastMessagePreview),
    unreadByAdmin: d.unreadByAdmin === true, unreadByCustomer: d.unreadByCustomer === true, createdAt: ts(d.createdAt)
  }
}

export function messageFromSnap(x: Snap): SupportMessage {
  const d = x.data() ?? {}
  return { id: x.id, from: d.from === 'admin' ? 'admin' : 'customer', body: s(d.body), authorName: s(d.authorName), at: ts(d.at) }
}

function audit(b: WriteBatch, action: string, by: string, t: SupportThread, details: string) {
  b.set(doc(auditCol()), {
    action, category: 'support', by, byUid: auth.currentUser?.uid ?? '', target: t.companyName || t.deviceId, targetType: 'support',
    licenseId: t.licenseId || null, details, meta: {}, status: 'success', archived: false, at: serverTimestamp()
  })
}

export async function replyToThread(t: SupportThread, body: string, authorName: string, status: SupportThread['status'], by: string): Promise<void> {
  const text = body.trim()
  if (!text) throw new Error('Type a message.')
  if (text.length > 4000) throw new Error('Message is too long (max 4000 characters).')
  const b = writeBatch(db)
  b.set(doc(messagesCol(t.id)), { from: 'admin', body: text, authorName: authorName.slice(0, 120), at: serverTimestamp() })
  b.update(threadRef(t.id), {
    lastMessageAt: serverTimestamp(), lastMessageFrom: 'admin', lastMessagePreview: text.slice(0, 200),
    unreadByCustomer: true, unreadByAdmin: false, status
  })
  audit(b, 'Support reply sent', by, t, text.slice(0, 120))
  await b.commit()
}

export async function setThreadStatus(t: SupportThread, status: SupportThread['status'], by: string): Promise<void> {
  const b = writeBatch(db)
  b.update(threadRef(t.id), { status })
  audit(b, 'Support status changed', by, t, `${t.status} -> ${status}`)
  await b.commit()
}

export async function markThreadRead(t: SupportThread): Promise<void> {
  if (!t.unreadByAdmin) return
  await updateDoc(threadRef(t.id), { unreadByAdmin: false })
}

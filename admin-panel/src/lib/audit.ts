/**
 * Activity log writer. Every admin action that changes data should call logActivity (or writeActivity /
 * writeAudit inside a batch / transaction). Rules require byUid == the signed-in admin, at == server time,
 * archived == false and a known category / status.
 */
import { addDoc, doc, serverTimestamp, type Transaction, type WriteBatch } from 'firebase/firestore'
import { auth } from '../firebase'
import { auditCol } from './licenses'
import type { AuditCategory } from './types'

export interface ActivityInput {
  action: string
  category: AuditCategory
  target?: string
  targetType?: string
  details?: string
  meta?: Record<string, unknown>
  status?: 'success' | 'failure'
  licenseId?: string | null
}

/** The auditLogs document for an activity (by / byUid = the signed-in admin). */
export function activityData(a: ActivityInput): Record<string, unknown> {
  const u = auth.currentUser
  return {
    action: a.action,
    category: a.category,
    by: u?.email ?? '',
    byUid: u?.uid ?? '',
    target: a.target ?? a.licenseId ?? '',
    targetType: a.targetType ?? (a.licenseId ? 'license' : ''),
    licenseId: a.licenseId ?? null,
    details: a.details ?? '',
    meta: a.meta ?? {},
    status: a.status ?? 'success',
    archived: false,
    at: serverTimestamp()
  }
}

export async function logActivity(a: ActivityInput): Promise<void> {
  if (!auth.currentUser) return
  await addDoc(auditCol(), activityData(a))
}

/** Best-effort variant for logging failures (never throws). */
export function logActivitySafe(a: ActivityInput): void {
  logActivity(a).catch(() => undefined)
}

/** Adds the activity entry to a batch or transaction, so it is written atomically with the change it describes. */
export function writeActivity(w: Pick<WriteBatch, 'set'> | Pick<Transaction, 'set'>, a: ActivityInput): void {
  ;(w as WriteBatch).set(doc(auditCol()), activityData(a))
}

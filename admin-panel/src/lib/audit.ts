/**
 * Activity log writer. Every admin action that changes data should call logActivity (or writeAudit inside a
 * batch / transaction, see licenses.ts). Rules require byUid == the signed-in admin and at == server time.
 */
import { addDoc, serverTimestamp } from 'firebase/firestore'
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

export async function logActivity(a: ActivityInput): Promise<void> {
  const u = auth.currentUser
  if (!u) return
  await addDoc(auditCol(), {
    action: a.action,
    category: a.category,
    by: u.email ?? '',
    byUid: u.uid,
    target: a.target ?? '',
    targetType: a.targetType ?? '',
    licenseId: a.licenseId ?? null,
    details: a.details ?? '',
    meta: a.meta ?? {},
    status: a.status ?? 'success',
    archived: false,
    at: serverTimestamp()
  })
}

/** Best-effort variant for logging failures (never throws). */
export function logActivitySafe(a: ActivityInput): void {
  logActivity(a).catch(() => undefined)
}

/**
 * Clearing (deleting) activity entries, license history and released device records.
 *
 * Flow: count first with paged queries (the exact references are kept), the admin confirms the exact number,
 * then the same references are deleted in batches of <= CLEAR_BATCH_SIZE with progress. One 'security' entry
 * records who cleared what and how many — security entries themselves are never deleted (the rules refuse it).
 * Pure scope / batching logic lives in auditLog.ts (unit tested).
 */
import {
  Timestamp,
  documentId,
  getDocs,
  limit,
  orderBy,
  query,
  startAfter,
  where,
  writeBatch,
  type DocumentData,
  type DocumentReference,
  type QueryConstraint,
  type QueryDocumentSnapshot
} from 'firebase/firestore'
import { db } from '../firebase'
import { auditCol, devicesCol, historyCol } from './licenses'
import { writeActivity } from './audit'
import { auditRowFromData, clearScopeMatches, clearScopeStrategy, describeClearScope, planClearBatches, type ClearScope } from './auditLog'
import { invalidate } from './queryCache'

const SCAN_PAGE = 400
type Snap = QueryDocumentSnapshot<DocumentData>

export interface ClearPlan {
  /** Exactly the documents that will be deleted. */
  refs: DocumentReference[]
  /** Entries in range that are protected (security) and will be kept. */
  kept: number
  /** Documents read while counting (cost indicator). */
  scanned: number
}

/** Pages through a query by its last document. */
async function scan(base: QueryConstraint[], visit: (docs: Snap[]) => void, col = auditCol()): Promise<number> {
  let cursor: Snap | null = null
  let scanned = 0
  for (;;) {
    const cons = [...base]
    if (cursor) cons.push(startAfter(cursor))
    cons.push(limit(SCAN_PAGE))
    const snap = await getDocs(query(col, ...cons))
    scanned += snap.size
    if (snap.empty) return scanned
    visit(snap.docs)
    if (snap.size < SCAN_PAGE) return scanned
    cursor = snap.docs[snap.docs.length - 1]
  }
}

/** Counts the activity entries a scope would delete (paged; never deletes). */
export async function planAuditClear(scope: ClearScope, onProgress?: (scanned: number) => void): Promise<ClearPlan> {
  const refs: DocumentReference[] = []
  let kept = 0
  let seen = 0
  const strat = clearScopeStrategy(scope)
  const base: QueryConstraint[] =
    strat.kind === 'category'
      ? [where('category', '==', strat.category), orderBy(documentId())]
      : [
          ...(strat.fromMs !== null ? [where('at', '>=', Timestamp.fromMillis(strat.fromMs))] : []),
          ...(strat.toMs !== null ? [where('at', '<=', Timestamp.fromMillis(strat.toMs))] : []),
          orderBy('at', 'asc')
        ]
  const scanned = await scan(base, (docs) => {
    for (const d of docs) {
      const row = auditRowFromData(d.id, d.data())
      if (clearScopeMatches(row, scope)) refs.push(d.ref)
      else if (row.category === 'security') kept++
    }
    seen += docs.length
    onProgress?.(seen)
  })
  return { refs, kept, scanned }
}

/** Deletes planned references in batches; the last batch also carries the security log entry. */
async function deleteInBatches(
  refs: DocumentReference[],
  log: Parameters<typeof writeActivity>[1],
  onProgress?: (done: number, total: number) => void
): Promise<number> {
  const batches = planClearBatches(refs)
  let done = 0
  for (const part of batches) {
    const b = writeBatch(db)
    part.forEach((r) => b.delete(r))
    await b.commit()
    done += part.length
    onProgress?.(done, refs.length)
  }
  const b = writeBatch(db)
  writeActivity(b, { ...log, meta: { ...(log.meta ?? {}), deleted: done } })
  await b.commit()
  return done
}

/** Deletes the planned activity entries and records one 'security' entry about the clearing. */
export async function runAuditClear(scope: ClearScope, plan: ClearPlan, onProgress?: (done: number, total: number) => void): Promise<number> {
  const what = describeClearScope(scope)
  const n = plan.refs.length
  const done = await deleteInBatches(
    plan.refs,
    {
      action: 'audit_cleared',
      category: 'security',
      targetType: 'audit_log',
      details: `${n} activity entr${n === 1 ? 'y' : 'ies'} deleted: ${what} (security entries are always kept)`,
      meta: { scope: { category: scope.category || 'all-non-security', fromMs: scope.fromMs, toMs: scope.toMs }, kept: plan.kept }
    },
    onProgress
  )
  invalidate('audit')
  return done
}

/** Counts a license's history entries (all of them may be cleared by audit.manage). */
export async function planLicenseHistoryClear(licenseId: string): Promise<ClearPlan> {
  const refs: DocumentReference[] = []
  const scanned = await scan([orderBy(documentId())], (docs) => docs.forEach((d) => refs.push(d.ref)), historyCol(licenseId))
  return { refs, kept: 0, scanned }
}

export async function runLicenseHistoryClear(licenseId: string, plan: ClearPlan, onProgress?: (done: number, total: number) => void): Promise<number> {
  const n = plan.refs.length
  return deleteInBatches(
    plan.refs,
    { action: 'license_history_cleared', category: 'security', targetType: 'license', target: licenseId, licenseId, details: `${n} license history entr${n === 1 ? 'y' : 'ies'} deleted` },
    onProgress
  )
}

/** Counts a license's released (non-active) device records; active devices are never cleared. */
export async function planReleasedDevicesClear(licenseId: string): Promise<ClearPlan> {
  const refs: DocumentReference[] = []
  let kept = 0
  const scanned = await scan([orderBy(documentId())], (docs) => {
    for (const d of docs) {
      if ((d.data().status ?? 'active') === 'active') kept++
      else refs.push(d.ref)
    }
  }, devicesCol(licenseId))
  return { refs, kept, scanned }
}

export async function runReleasedDevicesClear(licenseId: string, plan: ClearPlan, onProgress?: (done: number, total: number) => void): Promise<number> {
  const n = plan.refs.length
  return deleteInBatches(
    plan.refs,
    { action: 'released_devices_cleared', category: 'security', targetType: 'license', target: licenseId, licenseId, details: `${n} released device record${n === 1 ? '' : 's'} deleted (active devices kept)` },
    onProgress
  )
}

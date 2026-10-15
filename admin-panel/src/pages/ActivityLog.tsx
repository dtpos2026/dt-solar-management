/** Activity Log — every admin action, with filters, export, archiving and retention (Module 7). */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Timestamp,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  serverTimestamp,
  startAfter,
  where,
  writeBatch,
  type DocumentData,
  type QueryConstraint,
  type QueryDocumentSnapshot
} from 'firebase/firestore'
import { Activity, Archive, Download, Eraser, Filter, Loader2, RefreshCw, RotateCcw } from 'lucide-react'
import { db } from '../firebase'
import { Badge, Field, PageTitle, cx } from '../components/ui'
import { ConfirmDialog, Drawer, EmptyState, Loading, NoAccess, Notice, Pager, SearchBox, downloadText, usePaged } from '../components/kit'
import { auditCol } from '../lib/licenses'
import { logActivity, writeActivity } from '../lib/audit'
import { useAdmin, useCan } from '../lib/auth'
import { errorMessage, fmtDateTime, toInputDate } from '../lib/format'
import {
  AUDIT_CATEGORIES,
  EMPTY_FILTERS,
  PROTECTED_CATEGORIES,
  RETENTION_DAYS,
  actionLabel,
  auditCsv,
  auditRowFromData,
  chunk,
  dayEndMs,
  dayStartMs,
  distinctValues,
  filterAuditRows,
  isRetentionDeletable,
  retentionCutoff,
  type AuditFilters,
  type AuditRow
} from '../lib/auditLog'

const FETCH_SIZE = 200
const PAGE_SIZE = 25
const SCAN_SIZE = 400

const CATEGORY_TONE: Record<string, string> = {
  security: 'bg-red-50 text-red-700',
  financial: 'bg-emerald-50 text-emerald-700',
  license: 'bg-[#f1e9fb] text-[#3d096d]',
  client: 'bg-sky-50 text-sky-700',
  device: 'bg-indigo-50 text-indigo-700',
  support: 'bg-amber-50 text-amber-800',
  settings: 'bg-slate-100 text-slate-700',
  general: 'bg-slate-100 text-slate-600'
}

function CategoryPill({ c }: { c: string }) {
  return <span className={cx('inline-block rounded-md px-2 py-0.5 text-[11.5px] font-bold capitalize', CATEGORY_TONE[c] ?? CATEGORY_TONE.general)}>{c}</span>
}

type Snap = QueryDocumentSnapshot<DocumentData>

/** Scans auditLogs older than `cutoffMs` (oldest first) in pages; `visit` returns the docs to act on. */
async function scanOlderThan(cutoffMs: number, visit: (docs: Snap[]) => Promise<void>): Promise<void> {
  let cursor: Snap | null = null
  for (;;) {
    const cons: QueryConstraint[] = [where('at', '<', Timestamp.fromMillis(cutoffMs)), orderBy('at', 'asc')]
    if (cursor) cons.push(startAfter(cursor))
    cons.push(limit(SCAN_SIZE))
    const snap = await getDocs(query(auditCol(), ...cons))
    if (snap.empty) return
    await visit(snap.docs)
    if (snap.size < SCAN_SIZE) return
    cursor = snap.docs[snap.docs.length - 1]
  }
}

type Dialog = null | 'archiveSelected' | 'archiveOlder' | 'clear'

export function ActivityLog() {
  const can = useCan()
  const me = useAdmin()
  const canView = can('audit.view')
  const canManage = can('audit.manage')
  const isOwner = !!me?.isOwner
  const [rows, setRows] = useState<AuditRow[]>([])
  const [cursor, setCursor] = useState<Snap | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [f, setF] = useState<AuditFilters>(EMPTY_FILTERS)
  const [fromDay, setFromDay] = useState('')
  const [toDay, setToDay] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<AuditRow | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [olderDays, setOlderDays] = useState(180)
  const [busy, setBusy] = useState(false)
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [eligible, setEligible] = useState<{ count: number; kept: number } | null>(null)
  const [flash, setFlash] = useState<{ tone: 'success' | 'error'; text: string } | null>(null)

  const fromMs = fromDay ? dayStartMs(fromDay) : null
  const toMs = toDay ? dayEndMs(toDay) : null

  /** Server query: optional date range on `at` + order by `at` (single-field index only — no composite index). */
  const fetchPage = useCallback(
    async (after: Snap | null) => {
      const cons: QueryConstraint[] = []
      if (fromMs !== null) cons.push(where('at', '>=', Timestamp.fromMillis(fromMs)))
      if (toMs !== null) cons.push(where('at', '<=', Timestamp.fromMillis(toMs)))
      cons.push(orderBy('at', 'desc'))
      if (after) cons.push(startAfter(after))
      cons.push(limit(FETCH_SIZE))
      return getDocs(query(auditCol(), ...cons))
    },
    [fromMs, toMs]
  )

  const reload = useCallback(async () => {
    setLoading(true)
    setLoadError(null)
    try {
      const snap = await fetchPage(null)
      setRows(snap.docs.map((d) => auditRowFromData(d.id, d.data())))
      setCursor(snap.docs[snap.docs.length - 1] ?? null)
      setHasMore(snap.size === FETCH_SIZE)
      setSelected(new Set())
    } catch (e) {
      setLoadError(errorMessage(e))
    } finally {
      setLoading(false)
    }
  }, [fetchPage])

  useEffect(() => {
    if (canView) void reload()
  }, [canView, reload])

  const loadMore = async () => {
    if (!cursor) return
    setLoadingMore(true)
    try {
      const snap = await fetchPage(cursor)
      setRows((r) => [...r, ...snap.docs.map((d) => auditRowFromData(d.id, d.data()))])
      setCursor(snap.docs[snap.docs.length - 1] ?? cursor)
      setHasMore(snap.size === FETCH_SIZE)
    } catch (e) {
      setLoadError(errorMessage(e))
    } finally {
      setLoadingMore(false)
    }
  }

  const filters = useMemo<AuditFilters>(() => ({ ...f, fromMs, toMs }), [f, fromMs, toMs])
  const list = useMemo(() => filterAuditRows(rows, filters), [rows, filters])
  const admins = useMemo(() => distinctValues(rows, 'by'), [rows])
  const actions = useMemo(() => distinctValues(rows, 'action'), [rows])
  const paged = usePaged(list, PAGE_SIZE, JSON.stringify(filters))
  const filtered = !!(f.search || f.by || f.action || f.category || f.status || fromDay || toDay || f.showArchived)

  if (!canView) return <NoAccess what="the Activity Log" need="View activity log" />

  const set = (p: Partial<AuditFilters>) => setF((x) => ({ ...x, ...p }))
  const pageIds = paged.slice.filter((r) => !r.archived).map((r) => r.id)
  const allPageSelected = pageIds.length > 0 && pageIds.every((id) => selected.has(id))
  const toggleSel = (id: string, on: boolean) => setSelected((s) => { const n = new Set(s); if (on) n.add(id); else n.delete(id); return n })

  const exportCsv = async () => {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')
    downloadText(`dtsp-activity-log-${stamp}.csv`, auditCsv(list), 'text/csv;charset=utf-8')
    try {
      await logActivity({
        action: 'audit_exported',
        category: 'security',
        targetType: 'audit_log',
        details: `${list.length} entr${list.length === 1 ? 'y' : 'ies'} exported to CSV${filtered ? ' (filtered)' : ''}`,
        meta: { count: list.length, filters: { ...f, fromDay, toDay } }
      })
    } catch {
      /* the export itself worked */
    }
    setFlash({ tone: 'success', text: `${list.length} entries exported.` })
  }

  const archiveIds = async (ids: string[], reason: string) => {
    let done = 0
    for (const part of chunk(ids, SCAN_SIZE)) {
      const b = writeBatch(db)
      for (const id of part) b.update(doc(auditCol(), id), { archived: true, archivedAt: serverTimestamp(), archivedBy: me?.email ?? '' })
      await b.commit()
      done += part.length
      setProgress(`Archived ${done} of ${ids.length}…`)
    }
    await logActivity({ action: 'audit_archived', category: 'security', targetType: 'audit_log', details: `${ids.length} entr${ids.length === 1 ? 'y' : 'ies'} archived (${reason})`, meta: { count: ids.length } })
  }

  const runDialog = async () => {
    setBusy(true)
    setDialogError(null)
    setProgress(null)
    try {
      if (dialog === 'archiveSelected') {
        const ids = [...selected]
        await archiveIds(ids, 'selected')
        setFlash({ tone: 'success', text: `${ids.length} entries archived.` })
      } else if (dialog === 'archiveOlder') {
        const days = Math.round(olderDays)
        if (!Number.isFinite(days) || days < 1 || days > 3650) throw new Error('Enter a number of days between 1 and 3650.')
        const ids: string[] = []
        await scanOlderThan(Date.now() - days * 86_400_000, async (docs) => {
          ids.push(...docs.filter((d) => d.data().archived !== true).map((d) => d.id))
        })
        if (ids.length === 0) throw new Error(`No unarchived entries older than ${days} days.`)
        await archiveIds(ids, `older than ${days} days`)
        setFlash({ tone: 'success', text: `${ids.length} entries older than ${days} days archived.` })
      } else if (dialog === 'clear') {
        const nowMs = Date.now()
        let deleted = 0
        await scanOlderThan(retentionCutoff(nowMs), async (docs) => {
          const del = docs.filter((d) => isRetentionDeletable(auditRowFromData(d.id, d.data()), nowMs))
          if (!del.length) return
          const b = writeBatch(db)
          del.forEach((d) => b.delete(d.ref))
          await b.commit()
          deleted += del.length
          setProgress(`Deleted ${deleted}…`)
        })
        const b = writeBatch(db)
        writeActivity(b, {
          action: 'audit_retention_cleanup',
          category: 'security',
          targetType: 'audit_log',
          details: `${deleted} entr${deleted === 1 ? 'y' : 'ies'} older than ${RETENTION_DAYS} days deleted (security, financial and license entries are always kept)`,
          meta: { deleted, retentionDays: RETENTION_DAYS }
        })
        await b.commit()
        setFlash({ tone: 'success', text: `${deleted} old entries deleted. A record of this clean-up was added to the log.` })
      }
      setDialog(null)
      await reload()
    } catch (e) {
      setDialogError(errorMessage(e))
    } finally {
      setBusy(false)
      setProgress(null)
    }
  }

  const openClear = async () => {
    setDialog('clear')
    setDialogError(null)
    setEligible(null)
    try {
      const nowMs = Date.now()
      let count = 0
      let kept = 0
      await scanOlderThan(retentionCutoff(nowMs), async (docs) => {
        for (const d of docs) {
          if (isRetentionDeletable(auditRowFromData(d.id, d.data()), nowMs)) count++
          else kept++
        }
      })
      setEligible({ count, kept })
    } catch (e) {
      setDialogError(errorMessage(e))
    }
  }

  return (
    <div>
      <PageTitle
        title="Activity Log"
        sub={loading ? 'Loading…' : `${rows.length} entr${rows.length === 1 ? 'y' : 'ies'} loaded${hasMore ? ' (more available)' : ''} · newest first`}
        actions={
          <>
            <button className="btn btn-secondary" onClick={() => reload()} disabled={loading}><RefreshCw className={cx('h-4 w-4', loading && 'animate-spin')} />Refresh</button>
            <button className="btn btn-secondary" onClick={exportCsv} disabled={!list.length}><Download className="h-4 w-4" />Export CSV</button>
            {canManage && (
              <button className="btn btn-secondary" onClick={() => { setDialogError(null); setDialog('archiveOlder') }}><Archive className="h-4 w-4" />Archive older…</button>
            )}
            {isOwner && <button className="btn btn-secondary text-red-700" onClick={openClear}><Eraser className="h-4 w-4" />Clear old logs</button>}
          </>
        }
      />

      {flash && <Notice tone={flash.tone} className="mb-4" onClose={() => setFlash(null)}>{flash.text}</Notice>}

      <div className="card mb-3 p-3">
        <div className="flex flex-wrap items-end gap-2">
          <SearchBox className="w-72" value={f.search} onChange={(v) => set({ search: v })} placeholder="Search action, admin, target, details…" />
          <label className="text-[12px] text-[#6b5d85]">From<input type="date" className="input mt-0.5 w-40" value={fromDay} max={toDay || toInputDate(new Date())} onChange={(e) => setFromDay(e.target.value)} aria-label="From date" /></label>
          <label className="text-[12px] text-[#6b5d85]">To<input type="date" className="input mt-0.5 w-40" value={toDay} min={fromDay || undefined} onChange={(e) => setToDay(e.target.value)} aria-label="To date" /></label>
          <select className="input w-52" value={f.by} onChange={(e) => set({ by: e.target.value })} aria-label="Admin filter">
            <option value="">All admins</option>
            {admins.map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
          <select className="input w-52" value={f.action} onChange={(e) => set({ action: e.target.value })} aria-label="Action filter">
            <option value="">All actions</option>
            {actions.map((a) => <option key={a} value={a}>{actionLabel(a)}</option>)}
          </select>
          <select className="input w-40" value={f.category} onChange={(e) => set({ category: e.target.value })} aria-label="Category filter">
            <option value="">All categories</option>
            {AUDIT_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
          </select>
          <select className="input w-36" value={f.status} onChange={(e) => set({ status: e.target.value })} aria-label="Status filter">
            <option value="">Any status</option>
            <option value="success">Success</option>
            <option value="failure">Failure</option>
          </select>
          <label className="flex h-[38px] items-center gap-2 rounded-lg border border-[#ddd5ea] bg-white px-3 text-[13px]">
            <input type="checkbox" checked={f.showArchived} onChange={(e) => set({ showArchived: e.target.checked })} />Show archived
          </label>
          {filtered && (
            <button className="btn btn-secondary btn-sm h-[38px]" onClick={() => { setF(EMPTY_FILTERS); setFromDay(''); setToDay('') }}><RotateCcw className="h-4 w-4" />Reset</button>
          )}
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-[11.5px] text-[#7a6d92]">
          <Filter className="h-3.5 w-3.5" />
          The date range is applied by Firestore; the other filters search the {rows.length} loaded entries{hasMore ? ' — use “Load more” to search further back' : ''}.
        </div>
      </div>

      {canManage && selected.size > 0 && (
        <div className="mb-3 flex items-center justify-between rounded-xl bg-[#3d096d] px-4 py-2.5 text-[13px] text-white">
          <span>{selected.size} selected</span>
          <div className="flex gap-2">
            <button className="btn btn-sm bg-white/15 text-white hover:bg-white/25" onClick={() => setSelected(new Set())}>Clear selection</button>
            <button className="btn btn-sm bg-white text-[#3d096d]" onClick={() => { setDialogError(null); setDialog('archiveSelected') }}><Archive className="h-4 w-4" />Archive selected</button>
          </div>
        </div>
      )}

      <div className="card overflow-hidden">
        {loading ? (
          <Loading label="Loading activity…" />
        ) : loadError ? (
          <div className="p-4"><Notice tone="error">{loadError}</Notice></div>
        ) : list.length === 0 ? (
          <EmptyState icon={<Activity />} title={rows.length ? 'No entries match the filters' : 'No activity recorded yet'} hint={rows.length ? 'Change or reset the filters, or load older entries.' : 'Admin actions appear here as they happen.'}>
            {hasMore && <button className="btn btn-secondary" onClick={loadMore} disabled={loadingMore}>{loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}Load more</button>}
          </EmptyState>
        ) : (
          <>
            <table className="tbl">
              <thead>
                <tr>
                  {canManage && (
                    <th className="w-8"><input type="checkbox" aria-label="Select page" checked={allPageSelected} onChange={(e) => setSelected((s) => { const n = new Set(s); pageIds.forEach((id) => (e.target.checked ? n.add(id) : n.delete(id))); return n })} /></th>
                  )}
                  <th className="w-40">Time</th><th>Action</th><th>Category</th><th>Admin</th><th>Target</th><th>Details</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {paged.slice.map((r) => (
                  <tr key={r.id} className={cx('click', r.archived && 'opacity-55')} onClick={() => setDetail(r)}>
                    {canManage && (
                      <td onClick={(e) => e.stopPropagation()}>
                        <input type="checkbox" aria-label="Select entry" disabled={r.archived} checked={selected.has(r.id)} onChange={(e) => toggleSel(r.id, e.target.checked)} />
                      </td>
                    )}
                    <td className="text-[12.5px] whitespace-nowrap text-[#6b5d85]">{fmtDateTime(r.atMs)}</td>
                    <td className="font-semibold">{actionLabel(r.action)}{r.archived && <span className="ml-1.5 text-[11px] font-normal text-[#7a6d92]">archived</span>}</td>
                    <td><CategoryPill c={r.category} /></td>
                    <td className="max-w-[180px] truncate text-[12.5px]" title={r.by}>{r.by || '—'}</td>
                    <td className="max-w-[160px] truncate font-mono text-[12px]" title={r.target}>{r.target || '—'}</td>
                    <td className="max-w-[340px] truncate text-[12.5px]" title={r.details}>{r.details}</td>
                    <td><Badge tone={r.status === 'failure' ? 'rejected' : 'active'}>{r.status}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Pager {...paged} noun="entries" />
            {hasMore && (
              <div className="border-t border-[#ece6f4] px-4 py-2.5 text-center">
                <button className="btn btn-secondary btn-sm" onClick={loadMore} disabled={loadingMore}>{loadingMore && <Loader2 className="h-4 w-4 animate-spin" />}Load {FETCH_SIZE} older entries</button>
              </div>
            )}
          </>
        )}
      </div>

      <Drawer open={!!detail} onClose={() => setDetail(null)} title="Activity details">
        {detail && <DetailView r={detail} />}
      </Drawer>

      <ConfirmDialog open={dialog === 'archiveSelected'} title="Archive entries" confirmLabel={`Archive ${selected.size}`} busy={busy} error={dialogError} onConfirm={runDialog} onClose={() => setDialog(null)}>
        <p>Archive {selected.size} selected entr{selected.size === 1 ? 'y' : 'ies'}? Archived entries are hidden by default but never changed — tick “Show archived” to see them. Archiving cannot be undone.</p>
        {progress && <p className="text-[12.5px] text-[#6b5d85]">{progress}</p>}
      </ConfirmDialog>

      <ConfirmDialog open={dialog === 'archiveOlder'} title="Archive older entries" confirmLabel="Archive" busy={busy} error={dialogError} onConfirm={runDialog} onClose={() => setDialog(null)}>
        <Field label="Archive every entry older than (days)">
          <input className="input w-40" type="number" min={1} max={3650} value={olderDays} onChange={(e) => setOlderDays(Number(e.target.value))} />
        </Field>
        <p className="text-[12.5px] text-[#6b5d85]">Archived entries stay in the database and in exports; they are only hidden from the default view.</p>
        {progress && <p className="text-[12.5px] text-[#6b5d85]">{progress}</p>}
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'clear'}
        title="Clear old logs"
        confirmLabel={eligible ? `Delete ${eligible.count} entries` : 'Counting…'}
        danger
        busy={busy}
        disabled={!eligible || eligible.count === 0}
        error={dialogError}
        onConfirm={runDialog}
        onClose={() => setDialog(null)}
      >
        <p>Permanently delete activity entries older than <b>{RETENTION_DAYS} days</b>. Entries in the <b>{PROTECTED_CATEGORIES.join(', ')}</b> categories are always kept (the security rules refuse to delete them).</p>
        {eligible ? (
          <Notice tone={eligible.count ? 'warn' : 'info'}>{eligible.count} entr{eligible.count === 1 ? 'y' : 'ies'} can be deleted; {eligible.kept} older protected entr{eligible.kept === 1 ? 'y is' : 'ies are'} kept.</Notice>
        ) : (
          !dialogError && <p className="flex items-center gap-2 text-[12.5px] text-[#6b5d85]"><Loader2 className="h-4 w-4 animate-spin" />Counting eligible entries…</p>
        )}
        <p className="text-[12.5px] text-[#6b5d85]">This cannot be undone. A record of the clean-up is added to the log.</p>
        {progress && <p className="text-[12.5px] text-[#6b5d85]">{progress}</p>}
      </ConfirmDialog>
    </div>
  )
}

function DetailView({ r }: { r: AuditRow }) {
  const rows: [string, ReactNode][] = [
    ['Time', fmtDateTime(r.atMs)],
    ['Action', <><span className="font-semibold">{actionLabel(r.action)}</span> <span className="font-mono text-[12px] text-[#7a6d92]">{r.action}</span></>],
    ['Category', <><CategoryPill c={r.category} />{r.legacy && <span className="ml-2 text-[12px] text-[#7a6d92]">legacy entry (before categories) — shown as license</span>}</>],
    ['Status', <Badge tone={r.status === 'failure' ? 'rejected' : 'active'}>{r.status}</Badge>],
    ['Admin', <>{r.by || '—'}{r.byUid && <div className="font-mono text-[11.5px] text-[#7a6d92]">{r.byUid}</div>}</>],
    ['Target', <>{r.target || '—'}{r.targetType && <span className="ml-1 text-[12px] text-[#7a6d92]">({r.targetType})</span>}</>],
    ['License', r.licenseId ? <span className="font-mono text-[12px]">{r.licenseId}</span> : '—'],
    ['Archived', r.archived ? `Yes — ${fmtDateTime(r.archivedAtMs)}${r.archivedBy ? ` by ${r.archivedBy}` : ''}` : 'No'],
    ['Entry id', <span className="font-mono text-[12px]">{r.id}</span>]
  ]
  return (
    <div className="space-y-4 text-[13px]">
      <dl className="grid grid-cols-[110px_1fr] gap-x-3 gap-y-2">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-[12px] font-semibold text-[#7a6d92]">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
      <div>
        <div className="label">Details</div>
        <div className="rounded-xl border border-[#ece6f4] bg-[#fcfbfe] p-3 whitespace-pre-wrap">{r.details || '—'}</div>
      </div>
      <div>
        <div className="label">Meta</div>
        <pre className="max-h-80 overflow-auto rounded-xl border border-[#ece6f4] bg-[#1d1530] p-3 font-mono text-[11.5px] text-[#e9defa]">{Object.keys(r.meta).length ? JSON.stringify(r.meta, null, 2) : '{}'}</pre>
      </div>
    </div>
  )
}

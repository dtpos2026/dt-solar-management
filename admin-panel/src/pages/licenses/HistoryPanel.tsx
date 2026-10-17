/** License history, loaded only when opened and one page at a time (no listener on the whole sub-collection). */
import { useCallback, useEffect, useState } from 'react'
import { getDocs, limit, orderBy, query, startAfter, type QueryDocumentSnapshot, type DocumentData } from 'firebase/firestore'
import { History, Loader2 } from 'lucide-react'
import { historyCol, historyFromSnap } from '../../lib/licenses'
import { errorMessage, fmtDateTime } from '../../lib/format'
import type { HistoryEntry } from '../../lib/types'
import { Empty, Panel } from '../licensing/kit'

export const HISTORY_PAGE = 20
/** Actions about computers / activation (the "activation history" filter). */
const ACTIVATION_RE = /device|activat|certificate|reassign|trial|release/

export function HistoryPanel({ licenseId, refreshKey }: { licenseId: string; refreshKey?: unknown }) {
  const [open, setOpen] = useState(false)
  const [rows, setRows] = useState<HistoryEntry[]>([])
  const [cursor, setCursor] = useState<QueryDocumentSnapshot<DocumentData> | null>(null)
  const [more, setMore] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [onlyActivation, setOnlyActivation] = useState(false)

  const load = useCallback(
    async (after: QueryDocumentSnapshot<DocumentData> | null) => {
      setBusy(true)
      setErr(null)
      try {
        const q = after ? query(historyCol(licenseId), orderBy('at', 'desc'), startAfter(after), limit(HISTORY_PAGE)) : query(historyCol(licenseId), orderBy('at', 'desc'), limit(HISTORY_PAGE))
        const snap = await getDocs(q)
        const page = snap.docs.map(historyFromSnap)
        setRows((r) => (after ? [...r, ...page] : page))
        setCursor(snap.docs[snap.docs.length - 1] ?? after)
        setMore(snap.docs.length === HISTORY_PAGE)
      } catch (e) {
        setErr(errorMessage(e))
      } finally {
        setBusy(false)
      }
    },
    [licenseId]
  )

  // Reload the first page after a change made on this page (only while open).
  useEffect(() => {
    if (open) void load(null)
  }, [open, load, refreshKey])

  const shown = onlyActivation ? rows.filter((h) => ACTIVATION_RE.test(h.action)) : rows
  return (
    <Panel
      title="History"
      sub="Activations, approvals, rejections, reassignments, suspensions and every other change"
      actions={
        open ? (
          <label className="flex items-center gap-1 text-[12.5px]">
            <input type="checkbox" checked={onlyActivation} onChange={(e) => setOnlyActivation(e.target.checked)} />
            Activation / devices only
          </label>
        ) : (
          <button className="btn btn-sm btn-secondary" onClick={() => setOpen(true)}>
            <History className="h-4 w-4" />
            Show history
          </button>
        )
      }
    >
      {!open ? null : err ? (
        <div className="px-4 py-3 text-[13px] text-red-700">{err}</div>
      ) : rows.length === 0 && busy ? (
        <div className="flex items-center gap-2 px-4 py-3 text-[13px] text-[#7a6d92]"><Loader2 className="h-4 w-4 animate-spin" />Loading…</div>
      ) : shown.length === 0 ? (
        <Empty title={rows.length ? 'No activation entries on the loaded pages' : 'No history yet'} />
      ) : (
        <ul className="divide-y divide-[#f1ecf7] text-[13px]">
          {shown.map((h) => (
            <li key={h.id} className="px-4 py-2">
              <div className="flex justify-between gap-3"><b>{h.action.replace(/_/g, ' ')}</b><span className="text-[#7a6d92]">{fmtDateTime(h.at)}, {h.by}</span></div>
              {h.details && <div className="text-[#5d4f78]">{h.details}</div>}
            </li>
          ))}
        </ul>
      )}
      {open && more && (
        <div className="border-t border-[#ece6f4] px-4 py-2 text-center">
          <button className="btn btn-sm btn-secondary" disabled={busy} onClick={() => load(cursor)}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}Load {HISTORY_PAGE} more
          </button>
        </div>
      )}
    </Panel>
  )
}

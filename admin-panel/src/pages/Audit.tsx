import { useEffect, useState } from 'react'
import { limit, onSnapshot, orderBy, query } from 'firebase/firestore'
import { Link } from 'react-router-dom'
import { PageTitle } from '../components/ui'
import { auditCol, auditFromSnap } from '../lib/licenses'
import { fmtDateTime } from '../lib/format'
import type { AuditEntry } from '../lib/types'

export function Audit() {
  const [rows, setRows] = useState<AuditEntry[]>([])
  const [q, setQ] = useState('')
  useEffect(() => onSnapshot(query(auditCol(), orderBy('at', 'desc'), limit(300)), (s) => setRows(s.docs.map(auditFromSnap)), () => undefined), [])
  const list = rows.filter((r) => !q || `${r.action} ${r.details} ${r.by}`.toLowerCase().includes(q.toLowerCase()))
  return (
    <div>
      <PageTitle title="Audit log" sub="Every license action (latest 300)" actions={<input className="input w-72" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />} />
      <div className="card">
        <table className="tbl">
          <thead><tr><th>Time</th><th>Action</th><th>Details</th><th>By</th><th /></tr></thead>
          <tbody>
            {list.map((a) => (
              <tr key={a.id}>
                <td className="w-44 text-[12.5px]">{fmtDateTime(a.at)}</td><td className="font-semibold">{a.action.replace(/_/g, ' ')}</td><td className="text-[13px]">{a.details}</td><td className="text-[12px]">{a.by}</td>
                <td>{a.licenseId && <Link className="text-[12.5px] text-[#3d096d] underline" to={`/licenses/${a.licenseId}`}>Open</Link>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

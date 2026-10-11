import { useEffect, useState } from 'react'
import { api } from '../api'
import { round2, round3 } from '@shared/money'
import { InfoBox, Letterhead, PrintFooter, PrintTable, Sheet, Signatures, TemplateProps, pd, pm, pq } from './PrintKit'

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Material Issue Note (store → site) / Material Return Note (site → store). */
export function MaterialPrint({ id, ctx, setTitle }: TemplateProps): JSX.Element | null {
  const [m, setM] = useState<any>(null)
  const [canCost, setCanCost] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    // The print window has no app store, so ask the session whether costs may be shown.
    const me = api<any>('auth.me').catch(() => null)
    Promise.all([api<any>('materials.get', { id }), me])
      .then(([r, session]) => {
        const u = session?.user
        setCanCost(!!u && (u.isOwner || (u.permissions ?? []).includes('projects.financials')))
        setM(r)
        setTitle(`${r.direction === 'return' ? 'Material Return Note' : 'Material Issue Note'} ${r.number} - ${r.customer_name ?? r.project_name ?? ''}`.trim())
      })
      .catch((e) => setErr(e.message))
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="no-print mx-auto max-w-[210mm] rounded bg-red-100 p-4 text-red-800">{err}</div>
  if (!m) return null

  const isReturn = m.direction === 'return'
  const title = isReturn ? 'Material Return Note' : 'Material Issue Note'
  const cancelled = m.status === 'cancelled'
  const lines: any[] = m.lines ?? []
  const showCost = canCost && m.total_cost !== null && m.total_cost !== undefined
  const hasSerials = lines.some((l) => l.serials)
  const totalQty = round3(lines.reduce((a, l) => a + Number(l.qty || 0), 0))
  const colCount = 4 + (hasSerials ? 1 : 0) + (showCost ? 2 : 0)

  const meta: Array<[string, string]> = [
    [isReturn ? 'Return note #' : 'Issue note #', m.number],
    ['Date', pd(m.date)],
    ['Project #', m.project_code]
  ]
  if (cancelled) meta.push(['Status', 'Cancelled'])

  return (
    <Sheet ctx={ctx} watermark={cancelled ? { text: 'CANCELLED', color: '#c53030' } : null}>
      <Letterhead ctx={ctx} title={title} subtitle={isReturn ? 'Materials returned from site to store' : 'Materials issued from store to site'} meta={meta} />

      <div className="mb-3 grid grid-cols-2 gap-3">
        <InfoBox title="Project & Site">
          <div className="text-[12.5px] font-bold">{m.project_name}</div>
          <div>Project # {m.project_code}</div>
          {m.customer_name && <div>Customer: {m.customer_name}</div>}
          {m.site_address && <div>Site: {m.site_address}</div>}
        </InfoBox>
        <InfoBox title={isReturn ? 'Returned To' : 'Issued From'}>
          <div className="text-[12.5px] font-bold">{m.warehouse_name}</div>
          <div className="grid grid-cols-[auto_1fr] gap-x-3">
            <span className="text-[#4a5568]">Movement</span>
            <span>{isReturn ? 'Site → Store (stock in)' : 'Store → Site (stock out)'}</span>
            <span className="text-[#4a5568]">Prepared by</span>
            <span>{m.created_by_name ?? '—'}</span>
            <span className="text-[#4a5568]">Items</span>
            <span>
              {lines.length} line{lines.length === 1 ? '' : 's'} · Qty {pq(totalQty)}
            </span>
          </div>
        </InfoBox>
      </div>

      <PrintTable
        head={
          <>
            <th style={{ width: 26 }}>#</th>
            <th>Material</th>
            <th style={{ width: 66 }} className="!text-right">Qty</th>
            <th style={{ width: 46 }}>Unit</th>
            {hasSerials && <th style={{ width: 190 }}>Serial numbers</th>}
            {showCost && <th style={{ width: 78 }} className="!text-right">Unit cost</th>}
            {showCost && <th style={{ width: 88 }} className="!text-right">Cost</th>}
          </>
        }
      >
        {lines.map((l, i) => (
          <tr key={l.id ?? i}>
            <td className="text-[#718096]">{i + 1}</td>
            <td>
              <div className="font-semibold">{l.product_name}</div>
              {l.sku && <div className="text-[9.5px] text-[#4a5568]">SKU: {l.sku}</div>}
              {l.notes && <div className="text-[9.5px] text-[#4a5568]">{l.notes}</div>}
            </td>
            <td className="num text-right font-semibold">{pq(l.qty)}</td>
            <td>{l.unit ?? ''}</td>
            {hasSerials && (
              <td className="text-[9.5px] leading-snug break-words">
                {l.serials
                  ? String(l.serials)
                      .split(/[\n,;]+/)
                      .map((s) => s.trim())
                      .filter(Boolean)
                      .join(', ')
                  : '—'}
              </td>
            )}
            {showCost && <td className="num text-right">{pm(ctx, l.unit_cost, 2)}</td>}
            {showCost && <td className="num text-right">{pm(ctx, l.cost_total, 2)}</td>}
          </tr>
        ))}
        {lines.length < 5 &&
          Array.from({ length: 5 - lines.length }).map((_, i) => (
            <tr key={`pad${i}`}>
              <td colSpan={colCount} className="h-6" />
            </tr>
          ))}
        <tr className="font-bold">
          <td colSpan={2} className="text-right" style={{ background: '#e8eef6' }}>Total quantity</td>
          <td className="num text-right" style={{ background: '#e8eef6' }}>{pq(totalQty)}</td>
          <td colSpan={1 + (hasSerials ? 1 : 0) + (showCost ? 1 : 0)} style={{ background: '#e8eef6' }} />
          {showCost && <td className="num text-right" style={{ background: '#e8eef6' }}>{pm(ctx, round2(Number(m.total_cost)), 2)}</td>}
        </tr>
      </PrintTable>

      <div className="avoid-break mt-3 space-y-2 text-[10.5px]">
        {m.notes && (
          <div>
            <div className="text-[9px] font-bold tracking-wider text-[#718096] uppercase">Notes</div>
            <div className="whitespace-pre-line">{m.notes}</div>
          </div>
        )}
        <div className="text-[9.8px] text-[#4a5568]">
          {isReturn
            ? 'The above materials were returned from site in the stated quantity and condition and have been taken back into store.'
            : 'The above materials were issued in good condition for installation at the project site. Please verify quantities and serial numbers on receipt.'}
        </div>
        {cancelled && (
          <div className="rounded-md bg-[#fff5f5] px-2.5 py-1.5 text-[#c53030]">
            <b>This note has been cancelled</b>
            {m.cancelled_at ? ` on ${pd(m.cancelled_at)}` : ''} and the stock movement was reversed.
          </div>
        )}
      </div>

      <Signatures
        ctx={ctx}
        left={isReturn ? 'Returned by (site)' : 'Received by (site)'}
        right={isReturn ? 'Received by (store)' : 'Issued by (store)'}
      />
      <PrintFooter ctx={ctx} />
    </Sheet>
  )
}

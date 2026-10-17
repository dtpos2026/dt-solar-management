/** A4 print of a day / month closing (owner: data area). Opened with api('print.open', { kind: 'closing', id }). */
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Letterhead, PrintFooter, PrintTable, Sheet, Signatures, TemplateProps, pd, pm } from './PrintKit'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function ClosingPrint({ id, ctx, setTitle }: TemplateProps): JSX.Element | null {
  const [c, setC] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    api<any>('closing.get', { id })
      .then((r) => {
        setC(r)
        setTitle(r.kind === 'month' ? `Month Closing ${String(r.period_start).slice(0, 7)}` : `Day Closing ${r.period_start}`)
      })
      .catch((e) => setErr(e.message))
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="no-print mx-auto max-w-[210mm] rounded bg-red-100 p-4 text-red-800">{err}</div>
  if (!c) return null
  const s = c.summary ?? {}
  const isMonth = c.kind === 'month'
  const accounts: any[] = s.accounts ?? []
  const days: any[] = s.days ?? []
  const rows: Array<[string, number | null]> = [
    ['Opening cash', c.opening_cash],
    ['Cash in', c.cash_in],
    ['Cash out', c.cash_out],
    ['Expected closing cash', c.closing_cash],
    ['Counted cash', c.counted_cash],
    ['Difference (counted − expected)', c.counted_cash === null ? null : c.difference],
    ['Sales', c.sales_total],
    ['Purchases', c.purchases_total],
    ['Returns', s.returns ?? 0],
    ['Expenses', c.expenses_total],
    ['Receipts', c.receipts_total],
    ['Payments', c.payments_total]
  ]
  return (
    <Sheet ctx={ctx} watermark={c.status === 'reopened' ? { text: 'REOPENED', color: '#d97706' } : null}>
      <Letterhead
        ctx={ctx}
        title={isMonth ? 'Month Closing' : 'Day Closing'}
        meta={[
          ['Period', isMonth ? String(c.period_start).slice(0, 7) : pd(c.period_start)],
          ['Closed', String(c.closed_at ?? '')],
          ['Status', c.status === 'closed' ? 'Closed' : 'Reopened']
        ]}
      />
      <PrintTable
        head={
          <>
            <th>Figure</th>
            <th style={{ width: 140 }} className="!text-right">Amount</th>
          </>
        }
      >
        {rows.map(([l, v]) => (
          <tr key={l}>
            <td>{l}</td>
            <td className="text-right">{v === null || v === undefined ? '-' : pm(ctx, Number(v))}</td>
          </tr>
        ))}
      </PrintTable>
      {accounts.length > 0 && (
        <div className="mt-4">
          <PrintTable
            head={
              <>
                <th>Account</th>
                <th style={{ width: 60 }}>Type</th>
                <th style={{ width: 95 }} className="!text-right">Opening</th>
                <th style={{ width: 95 }} className="!text-right">In</th>
                <th style={{ width: 95 }} className="!text-right">Out</th>
                <th style={{ width: 95 }} className="!text-right">Closing</th>
              </>
            }
          >
            {accounts.map((a) => (
              <tr key={a.accountId}>
                <td>{a.name}</td>
                <td>{a.type}</td>
                <td className="text-right">{pm(ctx, a.opening)}</td>
                <td className="text-right">{pm(ctx, a.inflow)}</td>
                <td className="text-right">{pm(ctx, a.outflow)}</td>
                <td className="text-right">{pm(ctx, a.closing)}</td>
              </tr>
            ))}
          </PrintTable>
        </div>
      )}
      {isMonth && days.length > 0 && (
        <div className="mt-4">
          <PrintTable
            head={
              <>
                <th>Date</th>
                <th className="!text-right">Sales</th>
                <th className="!text-right">Purchases</th>
                <th className="!text-right">Expenses</th>
                <th className="!text-right">Receipts</th>
                <th className="!text-right">Payments</th>
              </>
            }
          >
            {days.map((d) => (
              <tr key={d.date}>
                <td>{pd(d.date)}</td>
                <td className="text-right">{pm(ctx, d.sales)}</td>
                <td className="text-right">{pm(ctx, d.purchases)}</td>
                <td className="text-right">{pm(ctx, d.expenses)}</td>
                <td className="text-right">{pm(ctx, d.receipts)}</td>
                <td className="text-right">{pm(ctx, d.payments)}</td>
              </tr>
            ))}
          </PrintTable>
        </div>
      )}
      {c.notes && <div className="mt-3 text-[10.5px]">Notes: {c.notes}</div>}
      {c.status === 'reopened' && <div className="mt-2 text-[10.5px] text-[#b45309]">Reopened {c.reopened_at}: {c.reopen_reason}</div>}
      <Signatures ctx={ctx} left="Closed by" right="Checked by" showReceiver={false} />
      <PrintFooter ctx={ctx} />
    </Sheet>
  )
}

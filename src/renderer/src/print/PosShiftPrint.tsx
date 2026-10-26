/** A4 print of a POS shift report (X while open, Z when closed). Opened with api('print.open', { kind: 'posshift', id }). */
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Letterhead, PrintFooter, PrintTable, Sheet, TemplateProps, pm } from './PrintKit'

/* eslint-disable @typescript-eslint/no-explicit-any */
const METHOD: Record<string, string> = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', online: 'Online / wallet' }

export function PosShiftPrint({ id, ctx, setTitle }: TemplateProps): JSX.Element | null {
  const [r, setR] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    api<any>('pos.shiftReport', { id })
      .then((x) => {
        setR(x)
        setTitle(`POS Shift ${x.shift.id} - ${x.cashier}`)
      })
      .catch((e) => setErr(e.message))
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="no-print mx-auto max-w-[210mm] rounded bg-red-100 p-4 text-red-800">{err}</div>
  if (!r) return null
  const s = r.shift
  const closed = s.status === 'closed'
  const rows: Array<[string, string, boolean?]> = [
    [`Sales (${r.sales.count} bills, ${r.sales.items} items)`, pm(ctx, r.sales.total, 2), true],
    ...(r.sales.discount > 0 ? ([['Discounts given', pm(ctx, r.sales.discount, 2)]] as Array<[string, string]>) : []),
    ...(r.cancelled.count > 0 ? ([[`Cancelled bills (${r.cancelled.count})`, pm(ctx, r.cancelled.total, 2)]] as Array<[string, string]>) : []),
    ...r.byMethod.map((m: any): [string, string] => [`Received by ${METHOD[m.method] ?? m.method}`, pm(ctx, m.amount, 2)]),
    ...(r.credit > 0 ? ([['Left on customer accounts', pm(ctx, r.credit, 2)]] as Array<[string, string]>) : [])
  ]
  const cash: Array<[string, string, boolean?]> = [
    ['Cash in the drawer at the start', pm(ctx, r.cash.opening, 2)],
    ['Cash from sales', pm(ctx, r.cash.sales, 2)],
    ['Cash put in', pm(ctx, r.cash.in, 2)],
    ['Cash taken out', `- ${pm(ctx, r.cash.out, 2)}`],
    ['The drawer should hold', pm(ctx, r.cash.expected, 2), true],
    ...(closed ? ([['Counted', pm(ctx, s.counted_cash, 2)], ['Difference (counted minus expected)', pm(ctx, s.difference, 2), true]] as Array<[string, string, boolean?]>) : [])
  ]
  const table = (title: string, data: Array<[string, string, boolean?]>): JSX.Element => (
    <PrintTable
      className="mb-4"
      head={
        <>
          <th>{title}</th>
          <th style={{ width: 150 }} className="!text-right">Amount</th>
        </>
      }
    >
      {data.map(([l, v, b]) => (
        <tr key={l}>
          <td className={b ? 'font-bold' : ''}>{l}</td>
          <td className={`num text-right ${b ? 'font-bold' : ''}`}>{v}</td>
        </tr>
      ))}
    </PrintTable>
  )
  return (
    <Sheet ctx={ctx}>
      <Letterhead
        ctx={ctx}
        title={closed ? 'Shift Report (Z)' : 'Shift Report (X)'}
        meta={[
          ['Cashier', r.cashier],
          ['Opened', String(s.opened_at)],
          ['Closed', closed ? String(s.closed_at) : 'Still open']
        ]}
      />
      {table('Sales', rows)}
      {table('Cash drawer', cash)}
      {r.moves.length > 0 && (
        <div className="mb-3 text-[10.5px]">
          <div className="mb-1 font-bold">Cash in and out</div>
          {r.moves.map((m: any, i: number) => (
            <div key={i}>
              {m.at} · {m.kind === 'in' ? 'In' : 'Out'} {pm(ctx, m.amount, 2)} {m.reason ? `· ${m.reason}` : ''}
            </div>
          ))}
        </div>
      )}
      {s.notes && <div className="mb-3 text-[10.5px]"><b>Note:</b> {s.notes}</div>}
      <PrintFooter ctx={ctx} />
    </Sheet>
  )
}

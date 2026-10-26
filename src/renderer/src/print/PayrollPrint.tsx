/** A4 print of a monthly salary sheet. Opened with api('print.open', { kind: 'payroll', id }). */
import { useEffect, useState } from 'react'
import { api } from '../api'
import { Letterhead, PrintFooter, PrintTable, Sheet, Signatures, TemplateProps, pm } from './PrintKit'

/* eslint-disable @typescript-eslint/no-explicit-any */
const monthName = (m: string): string => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })

export function PayrollPrint({ id, ctx, setTitle }: TemplateProps): JSX.Element | null {
  const [r, setR] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    api<any>('hr.payroll', { id })
      .then((x) => {
        setR(x)
        setTitle(`Salary Sheet ${x.run.month}`)
      })
      .catch((e) => setErr(e.message))
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="no-print mx-auto max-w-[210mm] rounded bg-red-100 p-4 text-red-800">{err}</div>
  if (!r) return null
  const paid = r.run.status === 'posted'
  const t = r.totals
  return (
    <Sheet ctx={ctx}>
      <Letterhead
        ctx={ctx}
        title="Salary Sheet"
        subtitle={monthName(r.run.month)}
        meta={[
          ['Month', monthName(r.run.month)],
          ['Status', paid ? `Paid ${String(r.run.posted_at ?? '').slice(0, 10)}` : 'Draft, not paid yet'],
          ['Employees', String(r.lines.length)]
        ]}
      />
      <PrintTable
        className="mb-4"
        head={
          <>
            <th style={{ width: 24 }}>#</th>
            <th>Employee</th>
            <th className="!text-right">Days</th>
            <th className="!text-right">Basic</th>
            <th className="!text-right">Overtime</th>
            <th className="!text-right">Bonus</th>
            <th className="!text-right">Deductions</th>
            <th className="!text-right">Advance back</th>
            <th className="!text-right">Net pay</th>
            <th style={{ width: 70 }}>Signature</th>
          </>
        }
        foot={
          <tr className="font-bold">
            <td />
            <td>Total</td>
            <td />
            <td className="num text-right">{pm(ctx, t.base, 2)}</td>
            <td className="num text-right">{pm(ctx, t.overtime, 2)}</td>
            <td className="num text-right">{pm(ctx, t.bonus, 2)}</td>
            <td className="num text-right">{pm(ctx, t.deductions, 2)}</td>
            <td className="num text-right">{pm(ctx, t.recovery, 2)}</td>
            <td className="num text-right">{pm(ctx, t.net, 2)}</td>
            <td />
          </tr>
        }
      >
        {r.lines.map((l: any, i: number) => (
          <tr key={l.id}>
            <td>{i + 1}</td>
            <td>
              <b>{l.name}</b>
              <div className="text-[9px] text-[#4a5568]">{l.designation ?? ''} {l.pay_type === 'daily' ? '(daily wage)' : ''}</div>
            </td>
            <td className="num text-right">{l.paid_days}</td>
            <td className="num text-right">{pm(ctx, l.base, 2)}</td>
            <td className="num text-right">{l.overtime_pay > 0 ? pm(ctx, l.overtime_pay, 2) : '-'}</td>
            <td className="num text-right">{l.bonus > 0 ? pm(ctx, l.bonus, 2) : '-'}</td>
            <td className="num text-right">{l.deductions > 0 ? pm(ctx, l.deductions, 2) : '-'}</td>
            <td className="num text-right">{l.advance_recovery > 0 ? pm(ctx, l.advance_recovery, 2) : '-'}</td>
            <td className="num text-right font-bold">{pm(ctx, l.net, 2)}</td>
            <td />
          </tr>
        ))}
      </PrintTable>
      <Signatures ctx={ctx} left="Prepared by" right="Authorised signature" />
      <PrintFooter ctx={ctx} />
    </Sheet>
  )
}

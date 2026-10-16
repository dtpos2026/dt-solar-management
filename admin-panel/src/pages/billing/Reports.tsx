/** Billing reports: sales by month, revenue (payments received) by month, outstanding by client, totals by plan type. */
import { useEffect, useMemo, useState } from 'react'
import { Download } from 'lucide-react'
import { Field } from '../../components/ui'
import { Loading, Notice } from '../../components/kit'
import { money, monthKey, round2, sumBy, toCsv } from '../../lib/billing'
import { errorMessage, fromInputDate, toDate, toInputDate } from '../../lib/format'
import type { Invoice, InvoicePayment } from '../../lib/types'
import { downloadCsv, loadInvoicePayments } from './common'

interface Pay extends InvoicePayment { invoiceNumber: string; clientName: string }

function inRange(d: Date | null, from: Date | null, to: Date | null): boolean {
  if (!d) return false
  if (from && d < from) return false
  if (to && d.getTime() > to.getTime() + 86400000 - 1) return false
  return true
}

export function BillingReports({ invoices, currency }: { invoices: Invoice[]; currency: string }) {
  const now = new Date()
  const [from, setFrom] = useState(toInputDate(new Date(now.getFullYear(), 0, 1)))
  const [to, setTo] = useState(toInputDate(now))
  const [payments, setPayments] = useState<Pay[] | null>(null)
  const [err, setErr] = useState<string | null>(null)

  // Payments live under each invoice (no collection-group rule): shared cached loader (also used by the Payments tab).
  const paidIds = invoices.filter((i) => i.lastPaymentAt || i.paid > 0).map((i) => `${i.id}:${i.paid}:${i.lastPaymentAt?.toMillis() ?? 0}`).join(',')
  useEffect(() => {
    let alive = true
    setPayments(null); setErr(null)
    loadInvoicePayments(invoices)
      .then((r) => alive && setPayments(r))
      .catch((e) => alive && (setErr(errorMessage(e)), setPayments([])))
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paidIds])

  const f = fromInputDate(from)
  const t = fromInputDate(to)
  const sales = useMemo(() => invoices.filter((i) => i.status !== 'cancelled' && inRange(toDate(i.issueDate), f, t)), [invoices, from, to]) // eslint-disable-line react-hooks/exhaustive-deps
  const salesByMonth = sumBy(sales, (i) => monthKey(toDate(i.issueDate)!), (i) => i.total)
  const received = (payments ?? []).filter((p) => !p.cancelled && inRange(toDate(p.date), f, t))
  const revenueByMonth = sumBy(received, (p) => monthKey(toDate(p.date)!), (p) => p.amount)
  const outstanding = sumBy(invoices.filter((i) => i.status !== 'cancelled' && i.balance > 0 && inRange(toDate(i.issueDate), f, t)), (i) => i.clientName || '—', (i) => i.balance).sort((a, b) => b.value - a.value)
  const byPlan = sumBy(sales, (i) => i.planType || 'other', (i) => i.total)

  const csvName = (n: string) => `${n}_${from}_${to}.csv`
  return (
    <div>
      <div className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <Field label="From (issue / payment date)"><input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <div className="pb-2 text-[12.5px] text-[#7a6d92]">Cancelled invoices and voided payments are excluded.</div>
      </div>
      {err && <Notice tone="error" className="mb-3">Payments could not be loaded: {err}</Notice>}
      <div className="grid grid-cols-2 gap-4">
        <ReportCard title="Sales by month" cols={['Month', 'Invoices', `Total (${currency})`]} rows={salesByMonth.map((r) => [r.key, r.count, r.value])}
          onCsv={() => downloadCsv(csvName('sales-by-month'), toCsv([['Month', 'Invoices', 'Total'], ...salesByMonth.map((r) => [r.key, r.count, r.value])]))} currency={currency} />
        {payments === null ? <div className="card"><Loading label="Loading payments…" /></div> : (
          <ReportCard title="Revenue received by month" cols={['Month', 'Payments', `Received (${currency})`]} rows={revenueByMonth.map((r) => [r.key, r.count, r.value])}
            onCsv={() => downloadCsv(csvName('revenue-by-month'), toCsv([['Month', 'Payments', 'Received'], ...revenueByMonth.map((r) => [r.key, r.count, r.value])]))} currency={currency} />
        )}
        <ReportCard title="Outstanding by client" cols={['Client', 'Invoices', `Outstanding (${currency})`]} rows={outstanding.map((r) => [r.key, r.count, r.value])}
          onCsv={() => downloadCsv(csvName('outstanding-by-client'), toCsv([['Client', 'Invoices', 'Outstanding'], ...outstanding.map((r) => [r.key, r.count, r.value])]))} currency={currency} />
        <ReportCard title="Totals by plan type" cols={['Plan type', 'Invoices', `Total (${currency})`]} rows={byPlan.map((r) => [r.key, r.count, r.value])}
          onCsv={() => downloadCsv(csvName('totals-by-plan'), toCsv([['Plan type', 'Invoices', 'Total'], ...byPlan.map((r) => [r.key, r.count, r.value])]))} currency={currency} />
      </div>
    </div>
  )
}

function ReportCard({ title, cols, rows, onCsv, currency }: { title: string; cols: string[]; rows: (string | number)[][]; onCsv: () => void; currency: string }) {
  const total = round2(rows.reduce((s, r) => s + Number(r[2]), 0))
  return (
    <div className="card">
      <div className="flex items-center justify-between border-b border-[#ece6f4] px-4 py-3">
        <span className="font-bold">{title}</span>
        <button className="btn btn-secondary btn-sm" onClick={onCsv} disabled={rows.length === 0}><Download className="h-4 w-4" /> CSV</button>
      </div>
      {rows.length === 0 ? <div className="px-4 py-8 text-center text-[13px] text-[#7a6d92]">No data in this date range.</div> : (
        <table className="tbl text-[13px]">
          <thead><tr>{cols.map((c, i) => <th key={c} className={i > 0 ? 'text-right' : ''}>{c}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => <tr key={String(r[0])}><td className="capitalize">{r[0]}</td><td className="text-right">{r[1]}</td><td className="text-right font-semibold">{money(Number(r[2]), '')}</td></tr>)}
            <tr><td className="font-bold">Total</td><td /><td className="text-right font-bold text-[#3d096d]">{money(total, currency)}</td></tr>
          </tbody>
        </table>
      )}
    </div>
  )
}

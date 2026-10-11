import { useEffect, useState } from 'react'
import { api } from '../api'
import { today } from '../lib/format'
import { PROJECT_STATUS_LABELS, ProjectStatus, SYSTEM_TYPE_LABELS } from '@shared/docTypes'
import { round2 } from '@shared/money'
import { InfoBox, Letterhead, PrintContext, PrintFooter, PrintTable, Sheet, Signatures, TemplateProps, TotalsBox, pd, pm, pq } from './PrintKit'

/* eslint-disable @typescript-eslint/no-explicit-any */
const KIND_LABELS: Record<string, string> = {
  sale_invoice: 'Invoice',
  sale_return: 'Credit Note',
  purchase_invoice: 'Purchase',
  purchase_return: 'Purch. Return',
  quotation: 'Quotation',
  sale_order: 'Sales Order',
  purchase_order: 'Purch. Order',
  delivery_challan: 'Challan',
  material_issue: 'Mat. Issue',
  material_return: 'Mat. Return',
  expense: 'Expense',
  receipt: 'Receipt',
  payment: 'Payment',
  adjustment: 'Journal'
}

const cap = (s: string | null | undefined): string => (s ? s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()) : '—')
const pctText = (n: number | null | undefined): string => (n === null || n === undefined ? '—' : `${n.toFixed(1)}%`)
const share = (part: number, whole: number): string => (Math.abs(whole) > 0.005 ? `${((part / whole) * 100).toFixed(1)}%` : '—')

/** Amount cell: blank for zero, red for negative. */
function Amt({ ctx, v, bold }: { ctx: PrintContext; v: number | null | undefined; bold?: boolean }): JSX.Element {
  const n = Number(v ?? 0)
  return <td className={`num text-right ${bold ? 'font-semibold' : ''} ${n < -0.005 ? 'text-[#c53030]' : ''}`}>{Math.abs(n) < 0.005 ? '' : pm(ctx, n, 2)}</td>
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'accent' | 'bad' | 'ok' }): JSX.Element {
  const accent = tone === 'accent'
  return (
    <div
      className={`rounded-md border px-2.5 py-1.5 ${accent ? 'text-white' : ''}`}
      style={accent ? { background: 'var(--pc)', borderColor: 'var(--pc)' } : { borderColor: '#e2e8f0', borderTop: '3px solid var(--pc)' }}
    >
      <div className={`text-[8.8px] font-bold tracking-wider uppercase ${accent ? 'text-white/85' : 'text-[#718096]'}`}>{label}</div>
      <div className={`num text-[13.5px] leading-tight font-extrabold ${tone === 'bad' ? 'text-[#c53030]' : tone === 'ok' ? 'text-[#2f855a]' : ''}`}>{value}</div>
      {sub && <div className={`text-[9px] ${accent ? 'text-white/85' : 'text-[#718096]'}`}>{sub}</div>}
    </div>
  )
}

function SectionTitle({ children }: { children: string }): JSX.Element {
  return (
    <div className="mt-4 mb-1.5 flex items-center gap-2 text-[10.5px] font-bold tracking-wider uppercase" style={{ color: 'var(--pc)' }}>
      {children}
      <div className="h-px flex-1" style={{ background: 'color-mix(in srgb, var(--pc) 30%, #fff)' }} />
    </div>
  )
}

/** Project Financial Statement: details, customer account, profitability, materials and the full project ledger. */
export function ProjectPrint({ id, ctx, setTitle }: TemplateProps): JSX.Element | null {
  const [data, setData] = useState<{ p: any; ledger: any[]; materials: any[] } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    Promise.all([api<any>('projects.get', { id }), api<any[]>('projects.ledger', { id }), api<any[]>('projects.materials', { id })])
      .then(([p, ledger, materials]) => {
        setData({ p, ledger: ledger ?? [], materials: materials ?? [] })
        setTitle(`Project Statement ${p.code} - ${p.customer_name ?? p.name}`)
      })
      .catch((e) => setErr(e.message))
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="no-print mx-auto max-w-[210mm] rounded bg-red-100 p-4 text-red-800">{err}</div>
  if (!data) return null

  const { p } = data
  const f = p.financials ?? {}
  // Cost & profit figures are stripped by the backend when the user lacks "projects.financials".
  const fin = f.revenue !== undefined && f.revenue !== null
  const ledger = data.ledger.filter((r) => r.status !== 'cancelled')
  const materials = data.materials
  const showMatCost = fin && materials.some((m) => m.cost !== null && m.cost !== undefined)
  const outstanding = Number(f.customerOutstanding ?? 0)
  const unbilled = f.unbilledContract ?? Math.max(0, round2(Number(f.contractValue ?? 0) - Number(f.invoicedTotal ?? 0)))

  const tot = ledger.reduce(
    (a, r) => ({
      revenue: a.revenue + Number(r.revenue || 0),
      cost: a.cost + Number(r.cost || 0),
      cashIn: a.cashIn + Number(r.cash_in || 0),
      cashOut: a.cashOut + Number(r.cash_out || 0)
    }),
    { revenue: 0, cost: 0, cashIn: 0, cashOut: 0 }
  )
  const matCostTotal = round2(materials.reduce((a, m) => a + Number(m.cost || 0), 0))

  const costRows: Array<{ label: string; value: number; sub?: boolean; strong?: boolean }> = fin
    ? [
        { label: 'Materials on sales invoices (stock cost)', value: f.materialFromInvoices, sub: true },
        { label: 'Materials issued from stock (net of returns)', value: f.materialIssued, sub: true },
        { label: 'Materials bought direct to site', value: f.materialDirectPurchase, sub: true },
        { label: 'Site material expenses', value: f.materialExpenses, sub: true },
        { label: 'Direct material cost', value: f.materialCost, strong: true },
        { label: 'Installation labor & contractors', value: f.laborCost, strong: true },
        { label: 'Transport & other direct cost', value: f.otherCost, strong: true },
        { label: 'Total direct cost', value: f.totalDirectCost, strong: true },
        { label: 'Allocated overheads', value: f.overheads },
        { label: 'Total cost incl. overheads', value: round2(Number(f.totalDirectCost) + Number(f.overheads)), strong: true }
      ]
    : []

  const status = PROJECT_STATUS_LABELS[p.status as ProjectStatus] ?? cap(p.status)
  const ledgerCols = fin ? 8 : 7

  return (
    <Sheet ctx={ctx} watermark={p.status === 'cancelled' ? { text: 'CANCELLED', color: '#c53030' } : null}>
      <Letterhead
        ctx={ctx}
        title="Project Statement"
        subtitle={fin ? 'Financial statement & profitability' : 'Project account statement'}
        meta={[
          ['Project #', p.code],
          ['Statement date', pd(today())],
          ['Status', status]
        ]}
      />

      <div className="mb-3 grid grid-cols-2 gap-3">
        <InfoBox title="Solar Project">
          <div className="text-[12.5px] font-bold">{p.name}</div>
          <div>
            {Number(p.capacity_kw) > 0 ? `${pq(p.capacity_kw)} kW · ` : ''}
            {SYSTEM_TYPE_LABELS[p.system_type] ?? cap(p.system_type)} system · {cap(p.project_type)}
          </div>
          {(p.site_address || p.city) && <div>Site: {[p.site_address, p.city].filter(Boolean).join(', ')}</div>}
          <div className="mt-1 grid grid-cols-[auto_1fr_auto_1fr] gap-x-2 text-[10px]">
            <span className="text-[#4a5568]">Start</span>
            <span>{pd(p.start_date)}</span>
            <span className="text-[#4a5568]">Expected end</span>
            <span>{pd(p.expected_end_date)}</span>
            {p.completed_date && (
              <>
                <span className="text-[#4a5568]">Completed</span>
                <span>{pd(p.completed_date)}</span>
              </>
            )}
            <span className="text-[#4a5568]">Manager</span>
            <span>{p.manager_name ?? '—'}</span>
            {p.quotation_number && (
              <>
                <span className="text-[#4a5568]">Quotation</span>
                <span>{p.quotation_number}</span>
              </>
            )}
          </div>
          <div className="mt-1.5 flex items-center gap-2 text-[10px]">
            <span className="text-[#4a5568]">Progress</span>
            <div className="h-[7px] flex-1 overflow-hidden rounded-full bg-[#e2e8f0]">
              <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, Number(p.progress) || 0))}%`, background: 'var(--pc)' }} />
            </div>
            <span className="font-semibold">{Number(p.progress) || 0}%</span>
          </div>
        </InfoBox>
        <InfoBox title="Customer">
          <div className="text-[12.5px] font-bold">{p.customer_name ?? '—'}</div>
          {p.customer_address && <div>{p.customer_address}</div>}
          {p.customer_phone && <div>Phone: {p.customer_phone}</div>}
          {p.customer_email && <div>Email: {p.customer_email}</div>}
          {(p.contact_person || p.contact_phone) && (
            <div className="mt-1 text-[10px]">
              <span className="text-[#4a5568]">Site contact: </span>
              {[p.contact_person, p.contact_phone].filter(Boolean).join(' · ')}
            </div>
          )}
        </InfoBox>
      </div>

      <SectionTitle>Financial summary</SectionTitle>
      <div className="avoid-break grid grid-cols-4 gap-2">
        <Tile label="Contract value" value={pm(ctx, f.contractValue, 2)} sub={unbilled > 0.005 ? `${pm(ctx, unbilled)} not yet invoiced` : 'Fully invoiced'} />
        <Tile label="Invoiced (incl. tax)" value={pm(ctx, f.invoicedTotal, 2)} sub={fin && f.taxCollected ? `Tax ${pm(ctx, f.taxCollected)}` : undefined} />
        <Tile label="Received" value={pm(ctx, f.received, 2)} tone="ok" />
        <Tile
          label={outstanding >= 0 ? 'Customer outstanding' : 'Customer advance'}
          value={pm(ctx, Math.abs(outstanding), 2)}
          tone={outstanding > 0.5 ? 'bad' : 'ok'}
          sub={outstanding > 0.5 ? 'Receivable' : outstanding < -0.5 ? 'Advance held' : 'Settled'}
        />
        {fin && (
          <>
            <Tile label="Revenue (excl. tax)" value={pm(ctx, f.revenue, 2)} />
            <Tile label="Total direct cost" value={pm(ctx, f.totalDirectCost, 2)} sub={`Material ${pm(ctx, f.materialCost)}`} />
            <Tile label="Gross profit" value={pm(ctx, f.grossProfit, 2)} tone={f.grossProfit < 0 ? 'bad' : undefined} sub={`Overheads ${pm(ctx, f.overheads)}`} />
            <Tile label="Net profit" value={pm(ctx, f.netProfit, 2)} tone="accent" sub={`Margin ${pctText(f.marginPct)}`} />
          </>
        )}
      </div>

      {fin ? (
        <div className="avoid-break mt-3 grid grid-cols-2 gap-3">
          <div className="overflow-hidden rounded-md border border-[#e2e8f0]">
            <div className="px-2.5 py-1 text-[9.5px] font-bold tracking-wider text-white uppercase" style={{ background: 'var(--pc)' }}>Customer account</div>
            <TotalsBox
              rows={[
                { label: 'Contract value', value: pm(ctx, f.contractValue, 2) },
                { label: 'Invoiced (incl. tax)', value: pm(ctx, f.invoicedTotal, 2) },
                { label: 'Sales tax on invoices', value: pm(ctx, f.taxCollected, 2) },
                { label: 'Received from customer', value: pm(ctx, f.received, 2) },
                { label: outstanding >= 0 ? 'Customer outstanding' : 'Customer advance', value: pm(ctx, Math.abs(outstanding), 2), strong: true, danger: outstanding > 0.5 },
                { label: 'Contract not yet invoiced', value: pm(ctx, unbilled, 2) },
                Number(f.supplierOutstanding) > 0.005 && { label: 'Supplier / contractor dues', value: pm(ctx, f.supplierOutstanding, 2) },
                Number(f.pendingPurchaseOrders) > 0 && { label: `Open purchase orders (${f.pendingPurchaseOrders})`, value: pm(ctx, f.pendingPurchaseValue, 2) }
              ]}
            />
          </div>
          <div className="overflow-hidden rounded-md border border-[#e2e8f0]">
            <div className="px-2.5 py-1 text-[9.5px] font-bold tracking-wider text-white uppercase" style={{ background: 'var(--pc)' }}>Profitability</div>
            <TotalsBox
              rows={[
                { label: 'Revenue (excl. tax)', value: pm(ctx, f.revenue, 2), strong: true },
                { label: 'Material cost', value: `- ${pm(ctx, f.materialCost, 2)}` },
                { label: 'Labor & contractor cost', value: `- ${pm(ctx, f.laborCost, 2)}` },
                { label: 'Transport & other cost', value: `- ${pm(ctx, f.otherCost, 2)}` },
                { label: 'Gross profit', value: pm(ctx, f.grossProfit, 2), strong: true, danger: f.grossProfit < 0 },
                { label: 'Overheads', value: `- ${pm(ctx, f.overheads, 2)}` },
                { label: 'Net profit', value: pm(ctx, f.netProfit, 2), accent: true },
                { label: 'Net margin', value: pctText(f.marginPct), strong: true, danger: f.netProfit < 0 }
              ]}
            />
          </div>
        </div>
      ) : (
        <div className="avoid-break mt-2 rounded-md bg-[#f7f9fc] px-2.5 py-1.5 text-[9.8px] text-[#4a5568]">
          Customer-facing amounts only. Cost and profit details are not included in this statement.
        </div>
      )}

      {fin && (
        <>
          <SectionTitle>Cost breakdown</SectionTitle>
          <PrintTable
            head={
              <>
                <th>Cost head</th>
                <th style={{ width: 110 }} className="!text-right">Amount</th>
                <th style={{ width: 100 }} className="!text-right">% of direct cost</th>
                <th style={{ width: 90 }} className="!text-right">% of revenue</th>
              </>
            }
          >
            {costRows.map((r) => (
              <tr key={r.label} className={r.strong ? 'font-semibold' : ''}>
                <td className={r.sub ? 'pl-5 text-[#4a5568]' : ''}>{r.label}</td>
                <td className="num text-right">{pm(ctx, r.value, 2)}</td>
                <td className="num text-right">{share(Number(r.value), Number(f.totalDirectCost))}</td>
                <td className="num text-right">{share(Number(r.value), Number(f.revenue))}</td>
              </tr>
            ))}
          </PrintTable>
        </>
      )}

      <SectionTitle>Material usage</SectionTitle>
      {materials.length === 0 ? (
        <div className="text-[10.5px] text-[#718096]">No materials issued, invoiced or delivered to this project yet.</div>
      ) : (
        <PrintTable
          head={
            <>
              <th style={{ width: 24 }}>#</th>
              <th>Material</th>
              <th style={{ width: 40 }}>Unit</th>
              <th style={{ width: 54 }} className="!text-right">Issued</th>
              <th style={{ width: 58 }} className="!text-right">Returned</th>
              <th style={{ width: 58 }} className="!text-right">Invoiced</th>
              <th style={{ width: 52 }} className="!text-right">Direct</th>
              <th style={{ width: 60 }} className="!text-right">Net used</th>
              {showMatCost && <th style={{ width: 86 }} className="!text-right">Cost</th>}
            </>
          }
        >
          {materials.map((m, i) => (
            <tr key={m.product_id ?? i}>
              <td className="text-[#718096]">{i + 1}</td>
              <td className="font-semibold">{m.product_name}</td>
              <td>{m.unit ?? ''}</td>
              <td className="num text-right">{Number(m.issued) ? pq(m.issued) : ''}</td>
              <td className="num text-right">{Number(m.returned) ? pq(m.returned) : ''}</td>
              <td className="num text-right">{Number(m.invoiced) ? pq(m.invoiced) : ''}</td>
              <td className="num text-right">{Number(m.direct) ? pq(m.direct) : ''}</td>
              <td className="num text-right font-semibold">{pq(m.net_used)}</td>
              {showMatCost && <td className="num text-right">{pm(ctx, m.cost, 2)}</td>}
            </tr>
          ))}
          {showMatCost && (
            <tr className="font-bold">
              <td colSpan={8} className="text-right" style={{ background: '#e8eef6' }}>Total material cost</td>
              <td className="num text-right" style={{ background: '#e8eef6' }}>{pm(ctx, matCostTotal, 2)}</td>
            </tr>
          )}
        </PrintTable>
      )}

      <SectionTitle>Project ledger</SectionTitle>
      {ledger.length === 0 ? (
        <div className="text-[10.5px] text-[#718096]">No transactions recorded for this project yet.</div>
      ) : (
        <PrintTable
          head={
            <>
              <th style={{ width: 66 }}>Date</th>
              <th style={{ width: 70 }}>Type</th>
              <th style={{ width: 74 }}>Number</th>
              <th>Description</th>
              {fin ? (
                <>
                  <th style={{ width: 74 }} className="!text-right">Revenue</th>
                  <th style={{ width: 74 }} className="!text-right">Cost</th>
                </>
              ) : (
                <th style={{ width: 80 }} className="!text-right">Amount</th>
              )}
              <th style={{ width: 74 }} className="!text-right">Cash in</th>
              <th style={{ width: 74 }} className="!text-right">Cash out</th>
            </>
          }
        >
          {ledger.map((r, i) => (
            <tr key={`${r.kind}-${r.ref_id}-${i}`}>
              <td className="whitespace-nowrap">{pd(r.date)}</td>
              <td>{KIND_LABELS[r.kind] ?? cap(r.kind)}</td>
              <td className="font-semibold">{r.number}</td>
              <td>
                {String(r.description ?? '').replace(/_/g, ' ')}
                {r.party && <div className="text-[9.5px] text-[#4a5568]">{r.party}</div>}
              </td>
              {fin ? (
                <>
                  <Amt ctx={ctx} v={r.revenue} />
                  <Amt ctx={ctx} v={r.cost} />
                </>
              ) : (
                <Amt ctx={ctx} v={r.kind === 'receipt' || r.kind === 'payment' ? null : r.doc_total} />
              )}
              <Amt ctx={ctx} v={r.cash_in} />
              <Amt ctx={ctx} v={r.cash_out} />
            </tr>
          ))}
          <tr className="font-bold">
            <td colSpan={4} className="text-right" style={{ background: '#e8eef6' }}>Totals</td>
            {fin ? (
              <>
                <td className="num text-right" style={{ background: '#e8eef6' }}>{pm(ctx, round2(tot.revenue), 2)}</td>
                <td className="num text-right" style={{ background: '#e8eef6' }}>{pm(ctx, round2(tot.cost), 2)}</td>
              </>
            ) : (
              <td style={{ background: '#e8eef6' }} />
            )}
            <td className="num text-right" style={{ background: '#e8eef6' }}>{pm(ctx, round2(tot.cashIn), 2)}</td>
            <td className="num text-right" style={{ background: '#e8eef6' }}>{pm(ctx, round2(tot.cashOut), 2)}</td>
          </tr>
          {fin && (
            <tr>
              <td colSpan={ledgerCols} className="text-[9.5px] text-[#718096]" style={{ background: '#fff' }}>
                Ledger cost covers stock & direct-to-site materials and project expenses (incl. unpaid bills). Overheads are allocated separately and are not part of the ledger.
              </td>
            </tr>
          )}
        </PrintTable>
      )}

      {(p.warranty_info || p.notes) && (
        <div className="avoid-break mt-4 grid grid-cols-2 gap-3">
          {p.warranty_info && (
            <InfoBox title="Warranty" className={p.notes ? '' : 'col-span-2'}>
              <div className="whitespace-pre-line">{p.warranty_info}</div>
            </InfoBox>
          )}
          {p.notes && (
            <InfoBox title="Notes" className={p.warranty_info ? '' : 'col-span-2'}>
              <div className="whitespace-pre-line">{p.notes}</div>
            </InfoBox>
          )}
        </div>
      )}

      {fin && (
        <div className="avoid-break mt-3 text-[9.5px] text-[#718096]">
          Profit is accrual based: invoiced revenue (excluding sales tax) less costs incurred. Cash received and paid is shown separately and does not affect profit.
        </div>
      )}

      <Signatures ctx={ctx} left="Prepared by" right={ctx.ps.signatureLabel} />
      <PrintFooter ctx={ctx} />
    </Sheet>
  )
}

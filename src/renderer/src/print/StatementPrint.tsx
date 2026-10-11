import { useEffect, useState } from 'react'
import { api } from '../api'
import { today } from '../lib/format'
import { InfoBox, Letterhead, PrintContext, PrintFooter, PrintTable, Sheet, Signatures, TemplateProps, pd, pm } from './PrintKit'

/* eslint-disable @typescript-eslint/no-explicit-any */
const KIND_LABELS: Record<string, string> = {
  opening: 'Opening',
  sale_invoice: 'Invoice',
  sale_return: 'Credit Note',
  purchase_invoice: 'Purchase Bill',
  purchase_return: 'Debit Note',
  receipt: 'Receipt',
  payment: 'Payment',
  expense: 'Expense Bill',
  expense_paid: 'Expense Paid',
  adjustment: 'Journal'
}

/** Clean a query-string date: empty, "undefined" or "null" means no limit. */
function qDate(v: string | undefined): string | undefined {
  return v && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : undefined
}

/** Signed balance as "1,250 Dr" / "800 Cr" (Dr = party owes us, Cr = we owe the party). */
function drCr(ctx: PrintContext, n: number): string {
  if (Math.abs(n) < 0.005) return pm(ctx, 0, 2)
  return `${pm(ctx, Math.abs(n), 2)} ${n > 0 ? 'Dr' : 'Cr'}`
}

function nature(n: number): string {
  return Math.abs(n) < 0.005 ? '(Settled)' : n > 0 ? '(Receivable)' : '(Payable)'
}

/** Customer / supplier account statement for a period, with running balance. */
export function StatementPrint({ id, params, ctx, setTitle }: TemplateProps): JSX.Element | null {
  const from = qDate(params.from)
  const to = qDate(params.to)
  const [L, setL] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    api<any>('parties.ledger', { id, from, to })
      .then((r) => {
        setL(r)
        const period = from || to ? ` (${from ? pd(from) : 'start'} to ${pd(to ?? today())})` : ''
        setTitle(`Account Statement - ${r.party?.name ?? ''}${period}`)
      })
      .catch((e) => setErr(e.message))
  }, [id, from, to]) // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="no-print mx-auto max-w-[210mm] rounded bg-red-100 p-4 text-red-800">{err}</div>
  if (!L) return null

  const party = L.party ?? {}
  const rows: any[] = L.rows ?? []
  const opening = Number(L.opening ?? 0)
  const closing = Number(L.closing ?? 0)
  const asOf = to ?? today()
  const isSupplier = party.type === 'supplier'
  const periodText = from ? `${pd(from)} to ${pd(asOf)}` : `Up to ${pd(asOf)}`
  // When no start date is given the ledger already contains the party's own opening entry.
  const showBf = !!from || rows[0]?.kind !== 'opening'
  const phones = [party.phone, party.phone2].filter(Boolean).join(' / ')
  const ids = [party.ntn && `NTN: ${party.ntn}`, party.strn && `STRN: ${party.strn}`, party.cnic && `CNIC: ${party.cnic}`].filter(Boolean).join(' · ')

  const tiles: Array<{ label: string; value: string; sub?: string; accent?: boolean }> = [
    { label: from ? `Opening balance (${pd(from)})` : 'Opening balance', value: drCr(ctx, opening), sub: nature(opening) },
    { label: 'Total debits', value: pm(ctx, L.totalDebit, 2), sub: isSupplier ? 'Payments, returns & charges' : 'Invoices, refunds & charges' },
    { label: 'Total credits', value: pm(ctx, L.totalCredit, 2), sub: isSupplier ? 'Bills & credits' : 'Receipts, returns & credits' },
    { label: `Closing balance (${pd(asOf)})`, value: drCr(ctx, closing), sub: nature(closing), accent: true }
  ]

  return (
    <Sheet ctx={ctx}>
      <Letterhead
        ctx={ctx}
        title="Account Statement"
        subtitle={party.type === 'both' ? 'Customer & supplier ledger' : isSupplier ? 'Supplier ledger' : 'Customer ledger'}
        meta={[
          ['Statement date', pd(today())],
          ['Period', periodText],
          ['Account #', String(party.id ?? id)]
        ]}
      />

      <div className="mb-3 grid grid-cols-[1fr_240px] gap-3">
        <InfoBox title={isSupplier ? 'Supplier' : 'Customer'}>
          <div className="text-[12.5px] font-bold">{party.name}</div>
          {party.contact_person && <div>Attn: {party.contact_person}</div>}
          {(party.address || party.city) && <div>{[party.address, party.city].filter(Boolean).join(', ')}</div>}
          {(phones || party.email) && (
            <div>
              {phones && <span>Phone: {phones}</span>}
              {phones && party.email && <span className="mx-1.5">|</span>}
              {party.email && <span>Email: {party.email}</span>}
            </div>
          )}
          {ids && <div className="text-[10px] text-[#4a5568]">{ids}</div>}
        </InfoBox>
        <InfoBox title="Statement Period">
          <div className="grid grid-cols-[auto_1fr] gap-x-3">
            <span className="text-[#4a5568]">From</span>
            <span className="font-semibold">{from ? pd(from) : 'Beginning'}</span>
            <span className="text-[#4a5568]">To</span>
            <span className="font-semibold">{pd(asOf)}</span>
            <span className="text-[#4a5568]">Entries</span>
            <span className="font-semibold">{rows.length}</span>
            {Number(party.credit_limit) > 0 && (
              <>
                <span className="text-[#4a5568]">Credit limit</span>
                <span className="font-semibold">{pm(ctx, party.credit_limit)}</span>
              </>
            )}
          </div>
        </InfoBox>
      </div>

      <div className="avoid-break mb-3 grid grid-cols-4 gap-2">
        {tiles.map((t) => (
          <div
            key={t.label}
            className={`rounded-md border px-2.5 py-1.5 ${t.accent ? 'text-white' : ''}`}
            style={t.accent ? { background: 'var(--pc)', borderColor: 'var(--pc)' } : { borderColor: '#e2e8f0', borderTop: '3px solid var(--pc)' }}
          >
            <div className={`text-[8.8px] font-bold tracking-wider uppercase ${t.accent ? 'text-white/85' : 'text-[#718096]'}`}>{t.label}</div>
            <div className="num text-[13.5px] leading-tight font-extrabold">{t.value}</div>
            {t.sub && <div className={`text-[9px] ${t.accent ? 'text-white/85' : 'text-[#718096]'}`}>{t.sub}</div>}
          </div>
        ))}
      </div>

      <PrintTable
        head={
          <>
            <th style={{ width: 70 }}>Date</th>
            <th style={{ width: 78 }}>Type</th>
            <th style={{ width: 84 }}>Number</th>
            <th>Description</th>
            <th style={{ width: 82 }} className="!text-right">Debit</th>
            <th style={{ width: 82 }} className="!text-right">Credit</th>
            <th style={{ width: 96 }} className="!text-right">Balance</th>
          </>
        }
      >
        {showBf && (
          <tr>
            <td style={{ background: '#f1f5f9' }}>{from ? pd(from) : '—'}</td>
            <td style={{ background: '#f1f5f9' }} colSpan={3} className="font-semibold">
              {from ? 'Opening balance brought forward' : 'Opening balance'}
            </td>
            <td style={{ background: '#f1f5f9' }} className="num text-right">{opening > 0 ? pm(ctx, opening, 2) : ''}</td>
            <td style={{ background: '#f1f5f9' }} className="num text-right">{opening < 0 ? pm(ctx, -opening, 2) : ''}</td>
            <td style={{ background: '#f1f5f9' }} className="num text-right font-semibold">{drCr(ctx, opening)}</td>
          </tr>
        )}
        {rows.map((r, i) => (
          <tr key={`${r.kind}-${r.ref_id ?? 'o'}-${i}`}>
            <td className="whitespace-nowrap">{pd(r.date)}</td>
            <td>{KIND_LABELS[r.kind] ?? r.kind}</td>
            <td className="font-semibold">{r.kind === 'opening' ? '—' : r.number}</td>
            <td>{r.description}</td>
            <td className="num text-right">{r.debit ? pm(ctx, r.debit, 2) : ''}</td>
            <td className="num text-right">{r.credit ? pm(ctx, r.credit, 2) : ''}</td>
            <td className="num text-right font-semibold">{drCr(ctx, r.balance)}</td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={7} className="py-4 text-center text-[#718096]">No transactions in this period.</td>
          </tr>
        )}
        <tr className="font-bold">
          <td colSpan={4} className="text-right" style={{ background: '#e8eef6' }}>Totals for the period</td>
          <td className="num text-right" style={{ background: '#e8eef6' }}>{pm(ctx, L.totalDebit, 2)}</td>
          <td className="num text-right" style={{ background: '#e8eef6' }}>{pm(ctx, L.totalCredit, 2)}</td>
          <td className="num text-right" style={{ background: '#e8eef6' }}>{drCr(ctx, closing)}</td>
        </tr>
      </PrintTable>

      <div className="avoid-break mt-3 grid grid-cols-[1fr_300px] items-start gap-5">
        <div className="text-[9.8px] leading-relaxed text-[#4a5568]">
          <div className="mb-0.5 text-[9px] font-bold tracking-wider text-[#718096] uppercase">How to read this statement</div>
          {isSupplier ? (
            <div>
              <b>Credit (Cr)</b> entries (purchase bills, expense bills) increase the amount {ctx.firm.name} owes you. <b>Debit (Dr)</b> entries (payments made, purchase returns /
              debit notes) reduce it. A <b>Cr</b> balance is payable by us; a <b>Dr</b> balance is receivable from you.
            </div>
          ) : (
            <div>
              <b>Debit (Dr)</b> entries (sales invoices, refunds, charges) increase the amount you owe {ctx.firm.name}. <b>Credit (Cr)</b> entries (payments received, sales returns /
              credit notes) reduce it. A <b>Dr</b> balance is receivable from you; a <b>Cr</b> balance is an advance held for you.
            </div>
          )}
          <div className="mt-1">Please report any discrepancy within 15 days of the statement date; otherwise the balance will be treated as confirmed.</div>
        </div>
        <div className="overflow-hidden rounded-md border border-[#e2e8f0]">
          <div className="flex items-center justify-between px-2.5 py-1.5 text-white" style={{ background: 'var(--pc)' }}>
            <span className="text-[11px] font-bold">Closing balance</span>
            <span className="num text-[13.5px] font-bold">{pm(ctx, Math.abs(closing), 2)}</span>
          </div>
          <div className="px-2.5 py-1 text-[10px]">
            <b>{nature(closing)}</b>{' '}
            <span className="text-[#4a5568]">
              {Math.abs(closing) < 0.005
                ? `Account fully settled as on ${pd(asOf)}.`
                : closing > 0
                  ? `Amount due from ${party.name} as on ${pd(asOf)}.`
                  : `Amount payable to ${party.name} as on ${pd(asOf)}.`}
            </span>
          </div>
        </div>
      </div>

      <Signatures ctx={ctx} showReceiver={false} />
      <PrintFooter ctx={ctx} />
    </Sheet>
  )
}

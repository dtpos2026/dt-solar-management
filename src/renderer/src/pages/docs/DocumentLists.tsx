import { useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { FileText, Plus, ShoppingBag, ShoppingCart } from 'lucide-react'
import { api } from '../../api'
import { useCan } from '../../store'
import { Badge, Button, Empty, PageHeader, PeriodPicker, Select, Tabs } from '../../components/ui'
import { DataTable, Column } from '../../components/DataTable'
import { useLoad } from '../../lib/hooks'
import { date, label, money, statusTone, PERIODS } from '../../lib/format'
import { DOC_TYPES, DocType } from '@shared/docTypes'

/* eslint-disable @typescript-eslint/no-explicit-any */
function DocList({ docType, partyNoun }: { docType: DocType; partyNoun: string }): JSX.Element {
  const nav = useNavigate()
  const [range, setRange] = useState<[string, string]>(PERIODS.find((p) => p.key === 'year')!.range())
  const [pay, setPay] = useState('')
  const meta = DOC_TYPES[docType]
  const { data, loading } = useLoad(() => api<any[]>('docs.list', { docType, from: range[0], to: range[1], payStatus: pay || undefined }), [docType, range[0], range[1], pay])
  const rows = data ?? []
  const financial = meta.financial
  const cols: Array<Column<any>> = [
    { key: 'number', header: 'Number', render: (r) => <span className="font-semibold text-brand">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => date(r.date) },
    { key: 'party_name', header: partyNoun, render: (r) => <div><div className="font-medium">{r.party_name ?? '—'}</div>{r.party_phone && <div className="text-[12px] text-muted">{r.party_phone}</div>}</div> },
    { key: 'project_name', header: 'Project', render: (r) => (r.project_name ? <span className="text-[12.5px]">{r.project_code} · {r.project_name}</span> : <span className="text-muted">—</span>) },
    { key: 'grand_total', header: 'Total', align: 'right', render: (r) => money(r.grand_total) },
    { key: 'paid', header: docType.includes('return') ? 'Settled' : 'Paid', align: 'right', hidden: !financial, render: (r) => money(r.paid + (r.returned || 0)), value: (r) => r.paid },
    { key: 'due', header: 'Balance', align: 'right', hidden: !financial, render: (r) => <span className={r.due > 0.5 ? 'font-semibold text-bad' : ''}>{money(r.due)}</span> },
    {
      key: 'status',
      header: 'Status',
      value: (r) => r.pay_status ?? r.status,
      render: (r) => (
        <div className="flex gap-1">
          {r.status === 'cancelled' ? <Badge tone="bad">Cancelled</Badge> : financial ? <Badge tone={statusTone(r.pay_status)}>{label(r.pay_status)}</Badge> : <Badge tone={statusTone(r.status)}>{label(r.status)}</Badge>}
          {r.is_tax_invoice ? <Badge tone="info">Tax</Badge> : null}
        </div>
      )
    },
    { key: 'created_by_name', header: 'By', render: (r) => <span className="text-[12px] text-muted">{r.created_by_name}</span> }
  ]
  const live = rows.filter((r) => r.status !== 'cancelled')
  const total = live.reduce((a, r) => a + r.grand_total, 0)
  const due = live.reduce((a, r) => a + (r.due || 0), 0)
  return (
    <DataTable
      rows={rows}
      columns={cols}
      loading={loading}
      onRowClick={(r) => nav(`/doc/${r.id}`)}
      exportName={meta.plural}
      searchPlaceholder={`Search ${meta.plural.toLowerCase()}…`}
      rowClassName={(r) => (r.status === 'cancelled' ? 'opacity-55' : undefined)}
      toolbar={
        <>
          <PeriodPicker from={range[0]} to={range[1]} onChange={(a, b) => setRange([a, b])} />
          {financial && (
            <Select sm className="w-36" value={pay} onChange={(e) => setPay(e.target.value)}>
              <option value="">All statuses</option>
              <option value="unpaid">Unpaid</option>
              <option value="partial">Partially paid</option>
              <option value="paid">Paid</option>
            </Select>
          )}
          <span className="ml-auto text-[12.5px] text-muted">
            {live.length} documents · Total <b className="text-ink">{money(total)}</b>
            {financial && (
              <>
                {' '}
                · Outstanding <b className="text-bad">{money(due)}</b>
              </>
            )}
          </span>
        </>
      }
      empty={
        <Empty icon={<FileText />} title={`No ${meta.plural.toLowerCase()} in this period`} action={<Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => nav(`/doc/new/${docType}`)}>New {meta.label}</Button>} />
      }
    />
  )
}

export function SalesPage(): JSX.Element {
  const can = useCan()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as DocType) || 'sale_invoice'
  return (
    <div>
      <PageHeader
        title="Sales"
        subtitle="Invoices, sales orders, delivery challans and returns"
        icon={<ShoppingCart className="h-5 w-5" />}
        actions={
          can('sales.create') && (
            <>
              {tab !== 'sale_invoice' && <Button icon={<Plus className="h-4 w-4" />} onClick={() => nav(`/doc/new/${tab}`)}>New {DOC_TYPES[tab].label}</Button>}
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => nav('/doc/new/sale_invoice')}>New Sales Invoice</Button>
            </>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={(t) => setParams({ tab: t })}
        tabs={[
          { key: 'sale_invoice', label: 'Sales Invoices' },
          { key: 'sale_order', label: 'Sales Orders' },
          { key: 'delivery_challan', label: 'Delivery Challans' },
          { key: 'sale_return', label: 'Returns / Credit Notes' }
        ]}
      />
      <DocList key={tab} docType={tab} partyNoun="Customer" />
    </div>
  )
}

export function QuotationsPage(): JSX.Element {
  const can = useCan()
  const nav = useNavigate()
  return (
    <div>
      <PageHeader
        title="Quotations & Estimates"
        subtitle="Send professional quotations and convert accepted ones into orders or invoices"
        icon={<FileText className="h-5 w-5" />}
        actions={can('quotations.manage') && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => nav('/doc/new/quotation')}>New Quotation</Button>}
      />
      <DocList docType="quotation" partyNoun="Customer" />
    </div>
  )
}

export function PurchasesPage(): JSX.Element {
  const can = useCan()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as DocType) || 'purchase_invoice'
  return (
    <div>
      <PageHeader
        title="Purchases"
        subtitle="Supplier bills, purchase orders and returns"
        icon={<ShoppingBag className="h-5 w-5" />}
        actions={
          can('purchases.create') && (
            <>
              {tab !== 'purchase_invoice' && <Button icon={<Plus className="h-4 w-4" />} onClick={() => nav(`/doc/new/${tab}`)}>New {DOC_TYPES[tab].label}</Button>}
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => nav('/doc/new/purchase_invoice')}>New Purchase</Button>
            </>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={(t) => setParams({ tab: t })}
        tabs={[
          { key: 'purchase_invoice', label: 'Purchase Invoices' },
          { key: 'purchase_order', label: 'Purchase Orders' },
          { key: 'purchase_return', label: 'Returns / Debit Notes' }
        ]}
      />
      <DocList key={tab} docType={tab} partyNoun="Supplier" />
    </div>
  )
}

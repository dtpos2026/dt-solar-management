import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Plus, Truck, Users, Pencil } from 'lucide-react'
import { api } from '../../api'
import { useCan } from '../../store'
import { Badge, Button, Checkbox, Empty, IconButton, PageHeader, Select } from '../../components/ui'
import { DataTable, Column } from '../../components/DataTable'
import { PartyForm } from '../../components/PartyForm'
import { useLoad } from '../../lib/hooks'
import { date, money } from '../../lib/format'

/* eslint-disable @typescript-eslint/no-explicit-any */
export function PartiesPage({ type }: { type: 'customer' | 'supplier' }): JSX.Element {
  const can = useCan()
  const nav = useNavigate()
  const [params, setParams] = useSearchParams()
  const [onlyDue, setOnlyDue] = useState(params.get('due') === '1')
  const [active, setActive] = useState('active')
  const [form, setForm] = useState<{ open: boolean; party?: any }>({ open: params.get('new') === '1' })
  useEffect(() => {
    if (params.get('new') === '1') setParams({}, { replace: true })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const { data, loading, reload } = useLoad(() => api<any[]>('parties.list', { type, active, onlyDue }), [type, active, onlyDue])
  const rows = data ?? []
  const isCust = type === 'customer'
  const total = rows.reduce((a, r) => a + r.balance, 0)
  const cols: Array<Column<any>> = [
    { key: 'name', header: isCust ? 'Customer' : 'Supplier / contractor', render: (r) => <div><div className="font-medium">{r.name}</div>{r.contact_person && <div className="text-[12px] text-muted">{r.contact_person}</div>}</div> },
    { key: 'phone', header: 'Phone' },
    { key: 'city', header: 'City' },
    { key: 'type', header: 'Type', render: (r) => (r.type === 'both' ? <Badge tone="info">Customer & supplier</Badge> : null), csv: false },
    { key: 'last_date', header: 'Last activity', render: (r) => date(r.last_date) },
    {
      key: 'balance',
      header: isCust ? 'Receivable' : 'Payable',
      align: 'right',
      render: (r) => {
        const owed = isCust ? r.balance : -r.balance
        return <span className={owed > 0.5 ? 'font-semibold text-bad' : owed < -0.5 ? 'font-semibold text-ok' : 'text-muted'}>{money(owed)}{owed < -0.5 && <span className="ml-1 text-[12px]">{isCust ? 'advance' : 'advance paid'}</span>}</span>
      },
      value: (r) => (isCust ? r.balance : -r.balance)
    },
    { key: 'is_active', header: '', csv: false, render: (r) => (!r.is_active ? <Badge tone="bad">Inactive</Badge> : null) },
    { key: 'a', header: '', sortable: false, csv: false, render: (r) => can(isCust ? 'customers.manage' : 'suppliers.manage') && <IconButton title="Edit" onClick={() => setForm({ open: true, party: r })}><Pencil className="h-4 w-4" /></IconButton> }
  ]
  return (
    <div>
      <PageHeader
        title={isCust ? 'Customers' : 'Suppliers & Contractors'}
        subtitle={isCust ? 'Customer profiles, balances and statements' : 'Supplier and installation contractor profiles, payables and statements'}
        icon={isCust ? <Users className="h-5 w-5" /> : <Truck className="h-5 w-5" />}
        actions={can(isCust ? 'customers.manage' : 'suppliers.manage') && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setForm({ open: true })}>New {isCust ? 'customer' : 'supplier'}</Button>}
      />
      <DataTable
        rows={rows}
        columns={cols}
        loading={loading}
        exportName={isCust ? 'Customers' : 'Suppliers'}
        onRowClick={(r) => nav(`/party/${r.id}`)}
        searchPlaceholder="Search name, phone, city…"
        toolbar={
          <>
            <Checkbox checked={onlyDue} onChange={setOnlyDue} label="Only with balance" />
            <Select sm className="w-32" value={active} onChange={(e) => setActive(e.target.value)}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="all">All</option>
            </Select>
            <span className="ml-auto text-[12.5px] text-muted">
              {rows.length} {isCust ? 'customers' : 'suppliers'} · Net {isCust ? 'receivable' : 'payable'} <b className="text-ink">{money(isCust ? total : -total)}</b>
            </span>
          </>
        }
        empty={<Empty icon={isCust ? <Users /> : <Truck />} title={`No ${isCust ? 'customers' : 'suppliers'} yet`} />}
      />
      <PartyForm open={form.open} party={form.party} type={type} onClose={() => setForm({ open: false })} onSaved={() => reload()} />
    </div>
  )
}

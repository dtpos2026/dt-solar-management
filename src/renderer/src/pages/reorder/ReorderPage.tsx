/** Reorder planning: items at or below their low-stock level, a suggested quantity and supplier, and one click to make the purchase orders. */
import { useEffect, useState } from 'react'
import { PackageSearch } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { api } from '../../api'
import { useCan } from '../../store'
import { Badge, Button, Card, Empty, Loading, NumberInput, PageHeader, Select, toast } from '../../components/ui'
import { useLoad, useParties } from '../../lib/hooks'
import { date, money, qty } from '../../lib/format'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Row { productId: number; picked: boolean; qty: number; supplierId: number | null }

export function ReorderPage(): JSX.Element {
  const can = useCan()
  const canOrder = can('purchases.create')
  const nav = useNavigate()
  const [cover, setCover] = useState(2)
  const [tick, setTick] = useState(0)
  const [rows, setRows] = useState<Record<number, Row>>({})
  const [busy, setBusy] = useState(false)
  const [made, setMade] = useState<Array<{ id: number; number: string; supplier: string; lines: number }> | null>(null)
  const { parties: suppliers } = useParties('supplier')
  const list = useLoad(() => api<any[]>('reorder.suggestions', { cover }), [cover, tick])

  useEffect(() => {
    if (!list.data) return
    setRows(Object.fromEntries(list.data.map((s) => [s.product_id, { productId: s.product_id, picked: true, qty: s.suggested_qty, supplierId: s.supplier_id }])))
  }, [list.data])

  const patch = (id: number, p: Partial<Row>): void => setRows((r) => ({ ...r, [id]: { ...r[id], ...p } }))
  const chosen = Object.values(rows).filter((r) => r.picked && r.qty > 0)
  const missing = chosen.filter((r) => !r.supplierId).length

  const create = async (): Promise<void> => {
    setBusy(true)
    try {
      const out = await api<Array<{ id: number; number: string; supplier: string; lines: number }>>('reorder.createOrders', { items: chosen.map((r) => ({ productId: r.productId, qty: r.qty, supplierId: r.supplierId })) })
      setMade(out)
      toast.ok(`${out.length} purchase order(s) made.`)
      setTick((t) => t + 1)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <PageHeader
        title="Reorder planning"
        subtitle="Items that are at or below their low-stock level, and what to order."
        icon={<PackageSearch className="h-5 w-5" />}
        actions={
          <div className="flex items-center gap-2">
            <Select sm className="w-52" value={cover} onChange={(e) => setCover(Number(e.target.value))} aria-label="How much to keep">
              {[1, 1.5, 2, 3, 4].map((c) => <option key={c} value={c}>Order up to {c}x the low-stock level</option>)}
            </Select>
            {canOrder && <Button variant="primary" loading={busy} disabled={!chosen.length} onClick={create}>Make purchase orders ({chosen.length})</Button>}
          </div>
        }
      />
      {made && (
        <Card>
          <div className="mb-2 text-[14px] font-semibold">Purchase orders made</div>
          <ul className="space-y-1 text-[13.5px]">
            {made.map((m) => <li key={m.id}><button type="button" className="font-medium text-brand hover:underline" onClick={() => nav(`/doc/${m.id}`)}>{m.number}</button> to {m.supplier}, {m.lines} item(s)</li>)}
          </ul>
        </Card>
      )}
      {missing > 0 && <div className="rounded-xl bg-warn/10 px-3 py-2 text-[13px] text-warn">{missing} chosen item(s) have no supplier. Choose one for each, or untick them.</div>}
      <Card pad={false}>
        {!list.data ? (
          <Loading />
        ) : list.data.length === 0 ? (
          <Empty icon={<PackageSearch />} title="Nothing to order">No item is at its low-stock level. Set a low-stock level on an item (Inventory, edit item) to have it watched here.</Empty>
        ) : (
          <table className="tbl">
            <thead><tr><th style={{ width: 32 }} /><th>Item</th><th className="text-right">In stock</th><th className="text-right">Low level</th><th className="text-right">Already ordered</th><th className="text-right">Order</th><th>Supplier</th><th className="text-right">Last rate</th></tr></thead>
            <tbody>
              {list.data.map((s) => {
                const r = rows[s.product_id]
                if (!r) return null
                return (
                  <tr key={s.product_id}>
                    <td><input type="checkbox" className="h-4 w-4 accent-[var(--brand)]" aria-label={`Order ${s.name}`} checked={r.picked} onChange={(e) => patch(s.product_id, { picked: e.target.checked })} /></td>
                    <td className="font-medium">{s.name}{s.sku && <div className="text-[12px] font-normal text-muted">{s.sku}</div>}</td>
                    <td className="num text-right"><Badge tone={s.stock <= 0 ? 'bad' : 'warn'}>{qty(s.stock)} {s.unit}</Badge></td>
                    <td className="num text-right">{qty(s.reorder_level)}</td>
                    <td className="num text-right">{s.on_order > 0 ? qty(s.on_order) : '-'}</td>
                    <td className="text-right"><NumberInput className="ml-auto w-24" sm value={r.qty} onChange={(v) => patch(s.product_id, { qty: v })} min={0} /></td>
                    <td>
                      <Select sm className="w-48" value={r.supplierId ?? ''} onChange={(e) => patch(s.product_id, { supplierId: e.target.value ? Number(e.target.value) : null })} aria-label={`Supplier for ${s.name}`}>
                        <option value="">Choose supplier</option>
                        {suppliers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </Select>
                    </td>
                    <td className="num text-right">{s.last_rate ? <>{money(s.last_rate)}<div className="text-[12px] text-muted">{date(s.last_date)}</div></> : '-'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  )
}

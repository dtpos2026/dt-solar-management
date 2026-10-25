import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Boxes, Plus, Pencil, Trash2, ArrowLeftRight, ClipboardList, Search, Warehouse, Tags, ScanLine, Printer, Archive, ArchiveRestore } from 'lucide-react'
import { api } from '../../api'
import { useApp, useCan } from '../../store'
import { optionValue } from '@shared/options'
import { Badge, Button, Card, Checkbox, Empty, Field, IconButton, Input, Kv, Modal, NumberInput, PageHeader, PeriodPicker, Select, Tabs, Textarea, Toggle, toast } from '../../components/ui'
import { DataTable, Column } from '../../components/DataTable'
import { Combobox } from '../../components/Combobox'
import { useLoad, useProducts, useWarehouses } from '../../lib/hooks'
import { useOptions } from '../../lib/options'
import { date, label, money, qty, today, PERIODS } from '../../lib/format'
import { CategoryPickModal, DeleteCategoryModal, archiveProductsFlow, deleteProductFlow, restoreProductsFlow } from './productActions'
import { DateInput } from '../../components/DateInput'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Tab = 'products' | 'stock' | 'movements' | 'adjustments' | 'warehouses' | 'categories' | 'serials'

export function InventoryPage(): JSX.Element {
  const can = useCan()
  const opt = useOptions()
  const [params, setParams] = useSearchParams()
  const stockOn = opt('item.stock')
  const shown: Tab[] = ['products', ...(stockOn ? (['stock', 'movements', 'adjustments'] as Tab[]) : []), 'warehouses', ...(opt('item.category') ? (['categories'] as Tab[]) : []), ...(stockOn ? (['serials'] as Tab[]) : [])]
  const asked = (params.get('tab') as Tab) || 'products'
  const tab: Tab = shown.includes(asked) ? asked : 'products'
  const [productForm, setProductForm] = useState<{ open: boolean; product?: any }>({ open: false })
  const [adjust, setAdjust] = useState<{ open: boolean; kind: 'opening' | 'adjustment' }>({ open: false, kind: 'adjustment' })
  const [transfer, setTransfer] = useState(false)
  const [tick, setTick] = useState(0)
  const refresh = (): void => setTick((t) => t + 1)
  return (
    <div>
      <PageHeader
        title="Products & Inventory"
        subtitle="Solar panels, inverters, batteries, structures, cables, accessories and services - valued at moving average cost"
        icon={<Boxes className="h-5 w-5" />}
        actions={
          <>
            {stockOn && can('inventory.adjust') && <Button icon={<ArrowLeftRight className="h-4 w-4" />} onClick={() => setTransfer(true)}>Transfer</Button>}
            {stockOn && can('inventory.adjust') && <Button icon={<ClipboardList className="h-4 w-4" />} onClick={() => setAdjust({ open: true, kind: 'adjustment' })}>Stock adjustment</Button>}
            {stockOn && can('inventory.adjust') && <Button onClick={() => setAdjust({ open: true, kind: 'opening' })}>Opening stock</Button>}
            {can('inventory.manage') && <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setProductForm({ open: true })}>New product</Button>}
          </>
        }
      />
      <Tabs
        value={tab}
        onChange={(t) => setParams({ tab: t })}
        tabs={[
          { key: 'products', label: 'Products' },
          { key: 'stock', label: 'Stock & valuation' },
          { key: 'movements', label: 'Stock movements' },
          { key: 'adjustments', label: 'Adjustments' },
          { key: 'warehouses', label: 'Warehouses' },
          { key: 'categories', label: 'Categories' },
          { key: 'serials', label: 'Serial / warranty lookup' }
        ].filter((x) => shown.includes(x.key as Tab))}
      />
      {tab === 'products' && <ProductsTab tick={tick} onEdit={(p) => setProductForm({ open: true, product: p })} />}
      {tab === 'stock' && <StockTab key={tick} />}
      {tab === 'movements' && <MovementsTab key={tick} />}
      {tab === 'adjustments' && <AdjustmentsTab key={tick} />}
      {tab === 'warehouses' && <WarehousesTab />}
      {tab === 'categories' && <CategoriesTab />}
      {tab === 'serials' && <SerialsTab />}
      <ProductForm open={productForm.open} product={productForm.product} onClose={() => setProductForm({ open: false })} onSaved={refresh} />
      <AdjustmentForm open={adjust.open} kind={adjust.kind} onClose={() => setAdjust({ ...adjust, open: false })} onSaved={refresh} />
      <TransferForm open={transfer} onClose={() => setTransfer(false)} onSaved={refresh} />
    </div>
  )
}

function ProductsTab({ onEdit, tick }: { onEdit: (p: any) => void; tick: number }): JSX.Element {
  const can = useCan()
  const [params, setParams] = useSearchParams()
  const [stock, setStock] = useState(params.get('stock') ?? '')
  const [cat, setCat] = useState(params.get('category') ?? '')
  const [active, setActive] = useState<'active' | 'archived' | 'all'>('active')
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [catPick, setCatPick] = useState(false)
  const [detail, setDetail] = useState<number | null>(params.get('product') ? Number(params.get('product')) : null)
  const cats = useLoad(() => api<any[]>('categories.list'), [tick])
  const { data, loading, reload } = useLoad(
    () => api<{ rows: any[] }>('products.list', { q: search || undefined, stock: stock || undefined, categoryId: cat ? Number(cat) : undefined, active, limit: 5000 }),
    [search, stock, cat, active, tick]
  )
  useEffect(() => {
    const t = setTimeout(() => setSearch(q.trim()), 250)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => setSelected(new Set()), [search, stock, cat, active, tick])
  const rows = data?.rows ?? []
  const showCost = rows.some((r) => r.avg_cost !== null)
  const canDelete = can('inventory.delete')
  const canManage = can('inventory.manage')
  const canSelect = canDelete || canManage
  const selRows = rows.filter((r) => selected.has(r.id))
  const allSelected = rows.length > 0 && selRows.length === rows.length
  const toggle = (id: number): void =>
    setSelected((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  const refresh = async (): Promise<void> => {
    setSelected(new Set())
    await Promise.all([reload(), cats.reload()])
  }
  const cols: Array<Column<any>> = [
    {
      key: 'sel',
      hidden: !canSelect,
      sortable: false,
      csv: false,
      width: 36,
      header: (
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer accent-[var(--brand)]"
          aria-label="Select all products in this list"
          title="Select all products in this list"
          checked={allSelected}
          ref={(el) => {
            if (el) el.indeterminate = selRows.length > 0 && !allSelected
          }}
          onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))}
        />
      ),
      render: (r) => (
        <span onClick={(e) => e.stopPropagation()}>
          <input type="checkbox" className="h-4 w-4 cursor-pointer accent-[var(--brand)]" aria-label={`Select ${r.name}`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} />
        </span>
      )
    },
    { key: 'name', header: 'Product', render: (r) => <div><div className="font-medium">{r.name}</div><div className="text-[12px] text-muted">{[r.sku, r.brand, r.model].filter(Boolean).join(', ')}</div></div>, value: (r) => `${r.name} ${r.sku ?? ''} ${r.brand ?? ''} ${r.model ?? ''}` },
    { key: 'category_name', header: 'Category', render: (r) => r.category_name ?? <span className="text-muted">-</span> },
    { key: 'type', header: 'Type', render: (r) => <Badge tone={r.type === 'service' ? 'info' : 'muted'}>{r.type === 'service' ? 'Service' : 'Goods'}</Badge> },
    { key: 'stock', header: 'In stock', align: 'right', render: (r) => (r.type === 'service' ? '-' : <span className={r.stock <= 0 ? 'font-semibold text-bad' : r.reorder_level > 0 && r.stock <= r.reorder_level ? 'font-semibold text-warn' : ''}>{qty(r.stock)} {r.unit}</span>) },
    { key: 'avg_cost', header: 'Avg cost', align: 'right', hidden: !showCost, render: (r) => (r.type === 'service' ? '-' : money(r.avg_cost)) },
    { key: 'sale_price', header: 'Sale price', align: 'right', render: (r) => money(r.sale_price) },
    { key: 'stock_value', header: 'Stock value', align: 'right', hidden: !showCost, render: (r) => (r.type === 'service' ? '-' : money(r.stock_value)) },
    { key: 'flags', header: '', sortable: false, csv: false, render: (r) => <div className="flex gap-1">{r.track_serial ? <Badge tone="info">S/N</Badge> : null}{r.warranty_months ? <Badge tone="ok">{r.warranty_months}m</Badge> : null}{!r.is_active && <Badge tone="warn">Archived</Badge>}</div> },
    {
      key: 'actions', header: '', sortable: false, csv: false,
      render: (r) => (
        <div className="flex justify-end">
          {canManage && <IconButton title="Edit" onClick={() => onEdit(r)}><Pencil className="h-4 w-4" /></IconButton>}
          {canDelete && (r.is_active
            ? <IconButton title="Archive" onClick={async () => { if (await archiveProductsFlow([r.id], `“${r.name}”`)) refresh() }}><Archive className="h-4 w-4" /></IconButton>
            : <IconButton title="Restore" onClick={async () => { if (await restoreProductsFlow([r.id])) refresh() }}><ArchiveRestore className="h-4 w-4" /></IconButton>)}
          {canDelete && <IconButton title="Delete" tone="bad" onClick={async () => { if (await deleteProductFlow(r)) refresh() }}><Trash2 className="h-4 w-4" /></IconButton>}
        </div>
      )
    }
  ]
  const selActive = selRows.filter((r) => r.is_active).map((r) => r.id)
  const selArchived = selRows.filter((r) => !r.is_active).map((r) => r.id)
  return (
    <>
      {selRows.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-2 rounded-xl border border-brand/40 bg-brand-soft px-3 py-2 text-[13px]" role="region" aria-label="Bulk actions">
          <span className="font-semibold text-brand">{selRows.length} selected</span>
          {canManage && <Button size="sm" icon={<Tags className="h-4 w-4" />} onClick={() => setCatPick(true)}>Change category</Button>}
          {canDelete && selActive.length > 0 && <Button size="sm" icon={<Archive className="h-4 w-4" />} onClick={async () => { if (await archiveProductsFlow(selActive, `${selActive.length} product${selActive.length === 1 ? '' : 's'}`)) refresh() }}>Archive{selArchived.length ? ` (${selActive.length})` : ''}</Button>}
          {canDelete && selArchived.length > 0 && <Button size="sm" icon={<ArchiveRestore className="h-4 w-4" />} onClick={async () => { if (await restoreProductsFlow(selArchived)) refresh() }}>Restore{selActive.length ? ` (${selArchived.length})` : ''}</Button>}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear selection</Button>
        </div>
      )}
      <DataTable
        rows={rows}
        columns={cols}
        loading={loading}
        searchable={false}
        exportName={active === 'archived' ? 'Archived products' : 'Products'}
        onRowClick={(r) => setDetail(r.id)}
        rowClassName={(r) => (!r.is_active ? 'opacity-70' : undefined)}
        toolbar={
          <>
            <div className="relative w-64 max-w-full">
              <Search className="pointer-events-none absolute top-1/2 left-2.5 h-4 w-4 -translate-y-1/2 text-muted" />
              <Input sm className="pl-8" placeholder="Search name, SKU, brand, model…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <Select sm className="w-44" value={cat} onChange={(e) => { setCat(e.target.value); if (params.get('category')) setParams({ tab: 'products' }, { replace: true }) }} aria-label="Category filter">
              <option value="">All categories</option>
              {(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            <Select sm className="w-40" value={stock} onChange={(e) => setStock(e.target.value)} aria-label="Stock filter">
              <option value="">Any stock level</option>
              <option value="in">In stock</option>
              <option value="low">Low stock</option>
              <option value="out">Out of stock</option>
            </Select>
            <Select sm className="w-44" value={active} onChange={(e) => setActive(e.target.value as 'active' | 'archived' | 'all')} aria-label="Archived filter">
              <option value="active">Active products</option>
              <option value="archived">Show archived</option>
              <option value="all">Active + archived</option>
            </Select>
          </>
        }
        empty={
          active === 'archived'
            ? <Empty icon={<Archive />} title="No archived products">Products you archive (or that could not be deleted because they have history) appear here and can be restored.</Empty>
            : <Empty icon={<Boxes />} title="No products found">Add your solar panels, inverters, batteries and services to start invoicing.</Empty>
        }
      />
      <ProductDetail id={detail} onClose={() => setDetail(null)} onEdit={(p) => { setDetail(null); onEdit(p) }} onChanged={refresh} />
      <CategoryPickModal open={catPick} ids={selRows.map((r) => r.id)} categories={cats.data ?? []} onClose={() => setCatPick(false)} onDone={refresh} />
    </>
  )
}

function ProductDetail({ id, onClose, onEdit, onChanged }: { id: number | null; onClose: () => void; onEdit: (p: any) => void; onChanged: () => void }): JSX.Element {
  const can = useCan()
  const [p, setP] = useState<any>(null)
  const [moves, setMoves] = useState<any[]>([])
  const load = (pid: number): void => {
    api('products.get', { id: pid }).then(setP).catch((e) => { toast.error(e); onClose() })
  }
  useEffect(() => {
    if (!id) return
    setP(null)
    load(id)
    if (can('inventory.view')) api<any[]>('stock.movements', { productId: id, limit: 100 }).then(setMoves).catch(() => setMoves([]))
  }, [id]) // eslint-disable-line react-hooks/exhaustive-deps
  const after = (changed: boolean, stillExists = true): void => {
    if (!changed) return
    onChanged()
    if (stillExists && id) load(id)
    else onClose()
  }
  const footer = p && (
    <>
      {can('inventory.delete') && (
        <Button variant="ghost" className="mr-auto text-bad" icon={<Trash2 className="h-4 w-4" />} onClick={async () => {
          const ok = await deleteProductFlow(p)
          if (!ok) return
          const exists = await api('products.get', { id: p.id }).then(() => true).catch(() => false)
          after(true, exists)
        }}>Delete</Button>
      )}
      {can('inventory.delete') && (p.is_active
        ? <Button icon={<Archive className="h-4 w-4" />} onClick={async () => after(await archiveProductsFlow([p.id], `“${p.name}”`))}>Archive</Button>
        : <Button variant="success" icon={<ArchiveRestore className="h-4 w-4" />} onClick={async () => after(await restoreProductsFlow([p.id]))}>Restore</Button>)}
      {can('inventory.manage') && <Button variant="primary" icon={<Pencil className="h-4 w-4" />} onClick={() => onEdit(p)}>Edit product</Button>}
    </>
  )
  return (
    <Modal open={!!id} onClose={onClose} title={p?.name ?? 'Product'} subtitle={p ? [p.sku, p.category_name, p.brand, p.model].filter(Boolean).join(', ') : ''} size="lg" footer={footer}>
      {!p ? null : (
        <div className="space-y-4">
          {!p.is_active && (
            <div className="flex items-start gap-3 rounded-xl bg-warn-soft px-4 py-3 text-[13px]">
              <Archive className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
              <div><b>Archived{p.archived_at ? ` on ${date(String(p.archived_at).slice(0, 10))}` : ''}.</b> Hidden from new sales, purchases, quotations and project material issues. Past documents, stock movements and reports still show it.</div>
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            <Card><Kv label="Sale price">{money(p.sale_price)}</Kv>{p.avg_cost !== null && <Kv label="Average cost">{money(p.avg_cost)}</Kv>}{p.purchase_price !== null && <Kv label="Last purchase price">{money(p.purchase_price)}</Kv>}</Card>
            <Card><Kv label="Unit">{p.unit}</Kv><Kv label="Tax rate">{p.tax_rate}%</Kv><Kv label="Reorder level">{qty(p.reorder_level)}</Kv></Card>
            <Card><Kv label="Warranty">{p.warranty_months ? `${p.warranty_months} months` : '-'}</Kv><Kv label="Serial tracking">{p.track_serial ? 'Yes' : 'No'}</Kv><Kv label="Type">{label(p.type)}</Kv></Card>
          </div>
          {p.type === 'goods' && (
            <Card title="Stock by warehouse" pad={false}>
              <table className="tbl"><tbody>{p.stock_by_warehouse.map((w: any) => <tr key={w.warehouse_id}><td>{w.warehouse_name}</td><td className="num text-right font-semibold">{qty(w.qty)} {p.unit}</td></tr>)}</tbody></table>
            </Card>
          )}
          {p.serials_in_stock?.length > 0 && <Card title={`Serials in stock (${p.serials_in_stock.length})`}><div className="flex flex-wrap gap-1.5">{p.serials_in_stock.map((s: any) => <Badge key={s.serial}>{s.serial}</Badge>)}</div></Card>}
          {moves.length > 0 && (
            <Card title="Recent stock movements" pad={false}>
              <table className="tbl">
                <thead><tr><th>Date</th><th>Type</th><th>Ref</th><th>Warehouse</th><th className="text-right">In</th><th className="text-right">Out</th><th className="text-right">Unit cost</th></tr></thead>
                <tbody>{moves.map((m) => <tr key={m.id} className={m.is_reversal ? 'opacity-60' : ''}><td>{date(m.date)}</td><td>{label(m.ref_type)}{m.is_reversal ? ' (reversal)' : ''}</td><td>{m.ref_number ?? ''}{m.project_name ? `, ${m.project_name}` : ''}</td><td>{m.warehouse_name}</td><td className="num text-right text-ok">{m.qty_in ? qty(m.qty_in) : ''}</td><td className="num text-right text-bad">{m.qty_out ? qty(m.qty_out) : ''}</td><td className="num text-right">{money(m.unit_cost)}</td></tr>)}</tbody>
              </table>
            </Card>
          )}
        </div>
      )}
    </Modal>
  )
}

export function ProductForm({ open, product, onClose, onSaved }: { open: boolean; product?: any; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [f, setF] = useState<any>({})
  const [busy, setBusy] = useState(false)
  const cats = useLoad(() => api<any[]>('categories.list'), [open])
  const warehouses = useWarehouses()
  const can = useCan()
  const opt = useOptions()
  const settings = useApp((s) => s.settings)
  const typeMode = String(optionValue(settings, 'item.type_mode'))
  const defaultUnit = String(optionValue(settings, 'item.default_unit') || 'pcs')
  useEffect(() => {
    if (!open) return
    setF(
      product
        ? { id: product.id, name: product.name, categoryId: product.category_id, sku: product.sku ?? '', barcode: product.barcode ?? '', type: product.type, unit: product.unit, brand: product.brand ?? '', model: product.model ?? '', description: product.description ?? '', purchasePrice: product.purchase_price ?? 0, salePrice: product.sale_price, minSalePrice: product.min_sale_price ?? 0, taxRate: product.tax_rate, reorderLevel: product.reorder_level, trackSerial: !!product.track_serial, warrantyMonths: product.warranty_months, warrantyTerms: product.warranty_terms ?? '' }
        : { name: '', categoryId: null, sku: '', barcode: '', type: typeMode === 'service' ? 'service' : 'goods', unit: typeMode === 'service' ? 'job' : defaultUnit, brand: '', model: '', description: '', purchasePrice: 0, salePrice: 0, minSalePrice: 0, taxRate: 0, reorderLevel: 0, trackSerial: false, warrantyMonths: 0, warrantyTerms: '', openingQty: 0, openingCost: 0, openingWarehouseId: null, openingSerials: '' }
    )
  }, [open, product])
  const set = (k: string, v: unknown): void => setF((x: any) => ({ ...x, [k]: v }))
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await api('products.save', { ...f, openingCost: f.openingCost || f.purchasePrice })
      toast.ok('Product saved.')
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={product ? 'Edit product' : 'New product'} size="lg" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save product</Button></>}>
      {product && !product.is_active && (
        <div className="mb-3 flex items-start gap-3 rounded-xl bg-warn-soft px-4 py-2.5 text-[13px]">
          <Archive className="mt-0.5 h-4 w-4 shrink-0 text-warn" />
          <div>This product is <b>archived</b>. Saving keeps it archived - use <b>Restore</b> in the product list to make it available on new documents again.</div>
        </div>
      )}
      <div className="grid grid-cols-4 gap-3">
        <Field label="Product / service name" required className="col-span-3"><Input autoFocus value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Longi 585W Mono PERC Solar Panel" /></Field>
        {(typeMode === 'both' || (product && product.type !== (typeMode === 'goods' ? 'goods' : 'service'))) && (
        <Field label="Type">
          <Select value={f.type} onChange={(e) => set('type', e.target.value)}>
            <option value="goods">Goods (stock)</option>
            <option value="service">Service / labor</option>
          </Select>
        </Field>
        )}
        {opt('item.category') && <Field label="Category" className="col-span-2" hint={product ? 'Can be changed at any time - stock, costs and past documents are not affected.' : undefined}>
          <Select value={f.categoryId ?? ''} onChange={(e) => set('categoryId', e.target.value ? Number(e.target.value) : null)}>
            <option value="">None</option>
            {(cats.data ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>}
        {opt('item.codes') && <Field label="SKU / code"><Input value={f.sku ?? ''} onChange={(e) => set('sku', e.target.value)} /></Field>}
        {opt('item.codes') && <Field label="Barcode"><Input value={f.barcode ?? ''} onChange={(e) => set('barcode', e.target.value)} /></Field>}
        {opt('item.brand_model') && <Field label="Brand"><Input value={f.brand ?? ''} onChange={(e) => set('brand', e.target.value)} /></Field>}
        {opt('item.brand_model') && <Field label="Model / spec"><Input value={f.model ?? ''} onChange={(e) => set('model', e.target.value)} /></Field>}
        {opt('item.units') && <Field label="Unit" hint="pcs, m, kW, set, job…"><Input value={f.unit ?? ''} onChange={(e) => set('unit', e.target.value)} /></Field>}
        {opt('item.tax') && <Field label="Tax rate %"><NumberInput value={f.taxRate} onChange={(v) => set('taxRate', v)} /></Field>}
        {can('inventory.cost') && <Field label="Purchase price"><NumberInput value={f.purchasePrice} onChange={(v) => set('purchasePrice', v)} /></Field>}
        <Field label="Sale price"><NumberInput value={f.salePrice} onChange={(v) => set('salePrice', v)} /></Field>
        {opt('item.min_price') && <Field label="Minimum sale price" hint="Users without discount permission cannot sell below sale price."><NumberInput value={f.minSalePrice} onChange={(v) => set('minSalePrice', v)} /></Field>}
        {opt('item.reorder') && f.type === 'goods' && <Field label="Reorder level (low-stock alert)"><NumberInput value={f.reorderLevel} onChange={(v) => set('reorderLevel', v)} /></Field>}
        {opt('item.warranty') && <Field label="Warranty (months)"><NumberInput value={f.warrantyMonths} onChange={(v) => set('warrantyMonths', v)} /></Field>}
        {opt('item.warranty') && <Field label="Warranty terms" className="col-span-3"><Input value={f.warrantyTerms ?? ''} onChange={(e) => set('warrantyTerms', e.target.value)} placeholder="e.g. 12 years product, 25 years linear performance" /></Field>}
        {opt('item.description') && <Field label="Description" className="col-span-4"><Textarea rows={2} value={f.description ?? ''} onChange={(e) => set('description', e.target.value)} /></Field>}
        {opt('item.serials') && f.type === 'goods' && (
          <div className="col-span-4 flex flex-wrap gap-6">
            <Checkbox checked={!!f.trackSerial} onChange={(v) => set('trackSerial', v)} label="Track serial numbers (inverters, batteries…)" />
          </div>
        )}
        {!product && f.type === 'goods' && can('inventory.adjust') && (
          <div className="col-span-4 rounded-xl border border-dashed border-line p-3">
            <div className="mb-2 text-[13px] font-semibold">Opening stock (optional)</div>
            <div className="grid grid-cols-4 gap-3">
              <Field label="Quantity"><NumberInput value={f.openingQty} onChange={(v) => set('openingQty', v)} /></Field>
              <Field label="Cost per unit"><NumberInput value={f.openingCost} onChange={(v) => set('openingCost', v)} placeholder="= purchase price" /></Field>
              <Field label="Warehouse" className="col-span-2">
                <Select value={f.openingWarehouseId ?? ''} onChange={(e) => set('openingWarehouseId', e.target.value ? Number(e.target.value) : null)}>
                  <option value="">Default warehouse</option>
                  {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </Select>
              </Field>
              {f.trackSerial && <Field label="Serial numbers" className="col-span-4"><Input value={f.openingSerials ?? ''} onChange={(e) => set('openingSerials', e.target.value)} placeholder="Comma separated" /></Field>}
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}

function StockTab(): JSX.Element {
  const warehouses = useWarehouses()
  const [wh, setWh] = useState('')
  const [zero, setZero] = useState(false)
  const { data, loading } = useLoad(() => api<any>('stock.report', { warehouseId: wh ? Number(wh) : undefined, includeZero: zero }), [wh, zero])
  const rows = data?.rows ?? []
  const cols: Array<Column<any>> = [
    { key: 'name', header: 'Product', render: (r) => <div><div className="font-medium">{r.name}</div><div className="text-[12px] text-muted">{r.sku}</div></div> },
    { key: 'category_name', header: 'Category' },
    { key: 'qty', header: 'Quantity', align: 'right', render: (r) => <span className={r.qty <= 0 ? 'text-bad' : r.reorder_level > 0 && r.qty <= r.reorder_level ? 'text-warn' : ''}>{qty(r.qty)} {r.unit}</span> },
    { key: 'avg_cost', header: 'Avg cost', align: 'right', hidden: data?.totalValue === null, render: (r) => money(r.avg_cost) },
    { key: 'value', header: 'Stock value (cost)', align: 'right', hidden: data?.totalValue === null, render: (r) => money(r.value) },
    { key: 'sale_value', header: 'Value at sale price', align: 'right', render: (r) => money(r.sale_value) }
  ]
  return (
    <DataTable
      rows={rows}
      columns={cols}
      loading={loading}
      exportName="Stock valuation"
      toolbar={
        <>
          <Select sm className="w-48" value={wh} onChange={(e) => setWh(e.target.value)}>
            <option value="">All warehouses</option>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
          <Checkbox checked={zero} onChange={setZero} label="Include zero stock" />
          <Button size="sm" variant="ghost" icon={<Printer className="h-4 w-4" />} onClick={() => api('print.open', { kind: 'stock', id: 0, params: { warehouseId: wh } })}>Print</Button>
          <span className="ml-auto text-[12.5px] text-muted">
            {data?.totalValue !== null && data?.totalValue !== undefined && <>Stock value <b className="text-ink">{money(data.totalValue)}</b>, </>}
            At sale price <b className="text-ink">{money(data?.totalSaleValue ?? 0)}</b>, Method: {data?.method}
          </span>
        </>
      }
    />
  )
}

function MovementsTab(): JSX.Element {
  const { options } = useProducts(true)
  const [productId, setProductId] = useState<number | null>(null)
  const [range, setRange] = useState<[string, string]>(PERIODS.find((p) => p.key === 'quarter')!.range())
  const { data, loading } = useLoad(() => api<any[]>('stock.movements', { productId: productId ?? undefined, from: range[0], to: range[1], limit: 3000 }), [productId, range[0], range[1]])
  const cols: Array<Column<any>> = [
    { key: 'date', header: 'Date', render: (r) => date(r.date) },
    { key: 'product_name', header: 'Product' },
    { key: 'ref_type', header: 'Type', render: (r) => <span>{label(r.ref_type)}{r.is_reversal ? <Badge tone="warn" className="ml-1">Reversal</Badge> : null}</span> },
    { key: 'ref_number', header: 'Reference', render: (r) => <span>{r.ref_number ?? '-'}{r.project_name && <span className="text-muted">, {r.project_name}</span>}</span> },
    { key: 'warehouse_name', header: 'Warehouse' },
    { key: 'firm_name', header: 'Firm' },
    { key: 'qty_in', header: 'In', align: 'right', render: (r) => (r.qty_in ? <span className="text-ok">+{qty(r.qty_in)}</span> : '') },
    { key: 'qty_out', header: 'Out', align: 'right', render: (r) => (r.qty_out ? <span className="text-bad">-{qty(r.qty_out)}</span> : '') },
    { key: 'unit_cost', header: 'Unit cost', align: 'right', render: (r) => money(r.unit_cost) },
    { key: 'avg_cost_after', header: 'Avg after', align: 'right', render: (r) => money(r.avg_cost_after) }
  ]
  return (
    <DataTable
      rows={data ?? []}
      columns={cols}
      loading={loading}
      exportName="Stock movements"
      toolbar={
        <>
          <div className="w-72"><Combobox sm options={options} value={productId} onChange={setProductId} placeholder="All products" allowClear /></div>
          <PeriodPicker from={range[0]} to={range[1]} onChange={(a, b) => setRange([a, b])} />
        </>
      }
    />
  )
}

function AdjustmentsTab(): JSX.Element {
  const { data, loading } = useLoad(() => api<any[]>('stock.adjustments', {}), [])
  const [view, setView] = useState<any>(null)
  const cols: Array<Column<any>> = [
    { key: 'number', header: 'Number', render: (r) => <span className="font-semibold">{r.number}</span> },
    { key: 'date', header: 'Date', render: (r) => date(r.date) },
    { key: 'kind', header: 'Type', render: (r) => <Badge tone={r.kind === 'opening' ? 'info' : 'warn'}>{r.kind === 'opening' ? 'Opening stock' : 'Adjustment'}</Badge> },
    { key: 'warehouse_name', header: 'Warehouse' },
    { key: 'reason', header: 'Reason' },
    { key: 'line_count', header: 'Items', align: 'right' },
    { key: 'total_value', header: 'Value', align: 'right', render: (r) => <span className={r.total_value < 0 ? 'text-bad' : ''}>{money(r.total_value)}</span> },
    { key: 'created_by_name', header: 'By' }
  ]
  return (
    <>
      <DataTable rows={data ?? []} columns={cols} loading={loading} exportName="Stock adjustments" onRowClick={async (r) => setView(await api('stock.adjustment', { id: r.id }))} />
      <Modal open={!!view} onClose={() => setView(null)} title={`${view?.number} - ${view?.kind === 'opening' ? 'Opening stock' : 'Stock adjustment'}`} subtitle={view ? `${date(view.date)}, ${view.warehouse_name}, ${view.reason ?? ''}` : ''} size="lg">
        {view && (
          <table className="tbl">
            <thead><tr><th>Product</th><th className="text-right">Qty</th><th className="text-right">Unit cost</th><th className="text-right">Value</th><th>Serials</th></tr></thead>
            <tbody>{view.lines.map((l: any) => <tr key={l.id}><td>{l.product_name}</td><td className="num text-right">{qty(l.qty)} {l.unit}</td><td className="num text-right">{money(l.unit_cost)}</td><td className="num text-right">{money(l.value)}</td><td className="text-[12px]">{l.serials}</td></tr>)}</tbody>
          </table>
        )}
      </Modal>
    </>
  )
}

function AdjustmentForm({ open, kind, onClose, onSaved }: { open: boolean; kind: 'opening' | 'adjustment'; onClose: () => void; onSaved: () => void }): JSX.Element {
  const { options, products } = useProducts()
  const warehouses = useWarehouses()
  const [f, setF] = useState<any>({})
  const [lines, setLines] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setF({ date: today(), warehouseId: null, reason: kind === 'opening' ? 'Opening stock' : '', notes: '' })
      setLines([{ k: 1, productId: null, qty: 0, unitCost: 0, serials: '', dir: kind === 'opening' ? 'add' : 'remove' }])
    }
  }, [open, kind])
  useEffect(() => {
    if (open && !f.warehouseId && warehouses.length) setF((x: any) => ({ ...x, warehouseId: (warehouses.find((w) => w.is_default) ?? warehouses[0]).id }))
  }, [open, warehouses, f.warehouseId])
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await api('stock.adjust', {
        ...f,
        kind,
        lines: lines.filter((l) => l.productId && l.qty > 0).map((l) => ({ productId: l.productId, qty: l.dir === 'remove' ? -l.qty : l.qty, unitCost: l.unitCost || undefined, serials: l.serials }))
      })
      toast.ok('Stock updated.')
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title={kind === 'opening' ? 'Opening stock' : 'Stock adjustment'} subtitle={kind === 'opening' ? 'Record stock you already had before using the software (not counted as profit).' : 'Correct stock after a physical count, damage or loss. Value change appears in profit & loss.'} size="lg" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="mb-3 grid grid-cols-3 gap-3">
        <Field label="Date"><DateInput value={f.date ?? ''} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
        <Field label="Warehouse">
          <Select value={f.warehouseId ?? ''} onChange={(e) => setF({ ...f, warehouseId: Number(e.target.value) })}>
            {warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </Select>
        </Field>
        <Field label="Reason"><Input value={f.reason ?? ''} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder={kind === 'opening' ? '' : 'Damaged / physical count / lost'} /></Field>
      </div>
      <table className="tbl">
        <thead><tr><th>Product</th>{kind === 'adjustment' && <th style={{ width: 120 }}>Action</th>}<th style={{ width: 110 }}>Qty</th><th style={{ width: 130 }}>Unit cost</th><th /></tr></thead>
        <tbody>
          {lines.map((l, i) => {
            const p = products.find((x) => x.id === l.productId)
            return (
              <tr key={l.k}>
                <td>
                  <Combobox sm options={options} value={l.productId} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, productId: v, unitCost: products.find((pp) => pp.id === v)?.avg_cost || products.find((pp) => pp.id === v)?.purchase_price || 0 } : x)))} />
                  {p && <div className="mt-1 text-[12px] text-muted">Current stock: {qty(p.stock)} {p.unit}</div>}
                  {p?.track_serial ? <Input sm className="mt-1" placeholder="Serial numbers (comma separated)" value={l.serials} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, serials: e.target.value } : x)))} /> : null}
                </td>
                {kind === 'adjustment' && (
                  <td>
                    <Select sm value={l.dir} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, dir: e.target.value } : x)))}>
                      <option value="remove">Remove (−)</option>
                      <option value="add">Add (+)</option>
                    </Select>
                  </td>
                )}
                <td><NumberInput sm value={l.qty} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: v } : x)))} /></td>
                <td>{l.dir === 'add' ? <NumberInput sm value={l.unitCost} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, unitCost: v } : x)))} /> : <span className="text-[12px] text-muted">at average cost</span>}</td>
                <td><IconButton title="Remove" tone="bad" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></IconButton></td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <Button size="sm" variant="soft" className="mt-2" icon={<Plus className="h-4 w-4" />} onClick={() => setLines([...lines, { k: Date.now(), productId: null, qty: 0, unitCost: 0, serials: '', dir: kind === 'opening' ? 'add' : 'remove' }])}>Add product</Button>
    </Modal>
  )
}

function TransferForm({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: () => void }): JSX.Element {
  const { options } = useProducts()
  const warehouses = useWarehouses()
  const [f, setF] = useState<any>({})
  const [lines, setLines] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) {
      setF({ date: today(), fromWarehouseId: warehouses[0]?.id, toWarehouseId: warehouses[1]?.id, notes: '' })
      setLines([{ k: 1, productId: null, qty: 0 }])
    }
  }, [open, warehouses])
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      await api('stock.transfer', { ...f, lines: lines.filter((l) => l.productId && l.qty > 0) })
      toast.ok('Stock transferred.')
      onSaved()
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Transfer stock between warehouses" size="md" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save} disabled={warehouses.length < 2}>Transfer</Button></>}>
      {warehouses.length < 2 ? (
        <Empty icon={<Warehouse />} title="Only one warehouse">Create another warehouse in the Warehouses tab to transfer stock.</Empty>
      ) : (
        <>
          <div className="mb-3 grid grid-cols-3 gap-3">
            <Field label="Date"><DateInput value={f.date ?? ''} onChange={(e) => setF({ ...f, date: e.target.value })} /></Field>
            <Field label="From"><Select value={f.fromWarehouseId ?? ''} onChange={(e) => setF({ ...f, fromWarehouseId: Number(e.target.value) })}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
            <Field label="To"><Select value={f.toWarehouseId ?? ''} onChange={(e) => setF({ ...f, toWarehouseId: Number(e.target.value) })}>{warehouses.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}</Select></Field>
          </div>
          {lines.map((l, i) => (
            <div key={l.k} className="mb-2 flex gap-2">
              <div className="flex-1"><Combobox sm options={options} value={l.productId} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, productId: v } : x)))} /></div>
              <NumberInput sm className="w-28" value={l.qty} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, qty: v } : x)))} />
            </div>
          ))}
          <Button size="sm" variant="soft" icon={<Plus className="h-4 w-4" />} onClick={() => setLines([...lines, { k: Date.now(), productId: null, qty: 0 }])}>Add product</Button>
        </>
      )}
    </Modal>
  )
}

function WarehousesTab(): JSX.Element {
  const can = useCan()
  const { data, loading, reload } = useLoad(() => api<any[]>('warehouses.list', { includeInactive: true }), [])
  const [edit, setEdit] = useState<any>(null)
  const save = async (): Promise<void> => {
    try {
      await api('warehouses.save', edit)
      toast.ok('Warehouse saved.')
      setEdit(null)
      reload()
    } catch (e) {
      toast.error(e)
    }
  }
  return (
    <>
      <DataTable
        rows={data ?? []}
        loading={loading}
        searchable={false}
        toolbar={can('inventory.manage') && <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ name: '', address: '', isActive: true })}>New warehouse</Button>}
        columns={[
          { key: 'name', header: 'Warehouse', render: (r: any) => <div className="flex items-center gap-2"><Warehouse className="h-4 w-4 text-muted" /><span className="font-medium">{r.name}</span>{r.is_default ? <Badge tone="brand">Default</Badge> : null}</div> },
          { key: 'firm_id', header: 'Scope', render: (r: any) => (r.firm_id === null ? <Badge tone="info">Shared by all firms</Badge> : <Badge>This firm</Badge>) },
          { key: 'address', header: 'Address' },
          { key: 'stock_value', header: 'Stock value', align: 'right', render: (r: any) => money(r.stock_value) },
          { key: 'is_active', header: 'Status', render: (r: any) => (r.is_active ? <Badge tone="ok">Active</Badge> : <Badge tone="bad">Inactive</Badge>) },
          { key: 'a', header: '', sortable: false, render: (r: any) => can('inventory.manage') && <IconButton title="Edit" onClick={() => setEdit({ id: r.id, name: r.name, address: r.address ?? '', isActive: !!r.is_active })}><Pencil className="h-4 w-4" /></IconButton> }
        ]}
      />
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit warehouse' : 'New warehouse'} size="sm" footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
        {edit && (
          <div className="space-y-3">
            <Field label="Name"><Input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
            <Field label="Address"><Input value={edit.address} onChange={(e) => setEdit({ ...edit, address: e.target.value })} /></Field>
            {edit.id && <Toggle checked={edit.isActive} onChange={(v) => setEdit({ ...edit, isActive: v })} label="Active" />}
          </div>
        )}
      </Modal>
    </>
  )
}

function CategoriesTab(): JSX.Element {
  const can = useCan()
  const [, setParams] = useSearchParams()
  const { data, loading, reload } = useLoad(() => api<any[]>('categories.list'), [])
  const [edit, setEdit] = useState<any>(null)
  const [del, setDel] = useState<any>(null)
  const save = async (): Promise<void> => {
    try {
      await api('categories.save', edit)
      toast.ok(edit.id ? 'Category updated.' : 'Category created.')
      setEdit(null)
      reload()
    } catch (e) {
      toast.error(e)
    }
  }
  return (
    <>
      <DataTable
        rows={data ?? []}
        loading={loading}
        exportName="Categories"
        toolbar={can('inventory.manage') && <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setEdit({ name: '', kind: 'goods' })}>New category</Button>}
        columns={[
          { key: 'name', header: 'Category', render: (r: any) => <div className="flex items-center gap-2"><Tags className="h-4 w-4 text-muted" /><span className="font-medium">{r.name}</span></div> },
          { key: 'kind', header: 'Kind', render: (r: any) => <Badge tone={r.kind === 'service' ? 'info' : 'muted'}>{r.kind === 'service' ? 'Services' : 'Goods'}</Badge> },
          { key: 'firm_id', header: 'Scope', render: (r: any) => (r.firm_id === null ? <Badge tone="info">Shared by all firms</Badge> : <Badge>This firm</Badge>), value: (r: any) => (r.firm_id === null ? 'Shared' : 'This firm') },
          {
            key: 'product_count', header: 'Products', align: 'right',
            render: (r: any) => r.product_count > 0
              ? <button type="button" className="cursor-pointer text-brand hover:underline" title="Show these products" onClick={(e) => { e.stopPropagation(); setParams({ tab: 'products', category: String(r.id) }) }}>{r.active_count}{r.product_count > r.active_count ? <span className="text-muted"> + {r.product_count - r.active_count} archived</span> : ''}</button>
              : <span className="text-muted">0</span>
          },
          {
            key: 'a', header: '', sortable: false, csv: false,
            render: (r: any) => can('inventory.manage') && (
              <div className="flex justify-end">
                <IconButton title="Rename / change kind" onClick={() => setEdit({ id: r.id, name: r.name, kind: r.kind })}><Pencil className="h-4 w-4" /></IconButton>
                <IconButton title="Delete" tone="bad" onClick={() => setDel(r)}><Trash2 className="h-4 w-4" /></IconButton>
              </div>
            )
          }
        ]}
      />
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit category' : 'New category'} size="sm" footer={<><Button onClick={() => setEdit(null)}>Cancel</Button><Button variant="primary" onClick={save}>Save</Button></>}>
        {edit && (
          <div className="space-y-3">
            <Field label="Name"><Input autoFocus value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && save()} /></Field>
            <Field label="Kind" hint="Used for grouping and filters. Each product keeps its own goods / service type.">
              <Select value={edit.kind} onChange={(e) => setEdit({ ...edit, kind: e.target.value })}><option value="goods">Goods</option><option value="service">Services</option></Select>
            </Field>
          </div>
        )}
      </Modal>
      <DeleteCategoryModal category={del} categories={data ?? []} onClose={() => setDel(null)} onDone={reload} />
    </>
  )
}

function SerialsTab(): JSX.Element {
  const [params] = useSearchParams()
  const [q, setQ] = useState(params.get('serial') ?? '')
  const [rows, setRows] = useState<any[] | null>(null)
  const search = async (): Promise<void> => {
    try {
      setRows(await api<any[]>('serials.lookup', { serial: q }))
    } catch (e) {
      toast.error(e)
    }
  }
  useEffect(() => {
    if (q) search()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Card>
      <div className="flex gap-2">
        <div className="relative flex-1">
          <ScanLine className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted" />
          <Input className="pl-9" placeholder="Scan or type a serial number to see warranty, customer and invoice" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} autoFocus />
        </div>
        <Button variant="primary" icon={<Search className="h-4 w-4" />} onClick={search}>Search</Button>
      </div>
      {rows && (
        <div className="mt-4">
          {rows.length === 0 ? (
            <Empty title="Serial number not found" />
          ) : (
            <table className="tbl">
              <thead><tr><th>Serial</th><th>Product</th><th>Status</th><th>Customer / project</th><th>Sold on</th><th>Invoice</th><th>Warranty</th></tr></thead>
              <tbody>
                {rows.map((r) => {
                  const end = r.out_date && r.warranty_months ? new Date(new Date(r.out_date).setMonth(new Date(r.out_date).getMonth() + r.warranty_months)) : null
                  return (
                    <tr key={r.id}>
                      <td className="font-mono font-semibold">{r.serial}</td>
                      <td>{r.product_name}</td>
                      <td><Badge tone={r.status === 'in_stock' ? 'ok' : 'info'}>{label(r.status)}</Badge></td>
                      <td>{r.party_name ?? '-'}{r.project_name ? `, ${r.project_name}` : ''}</td>
                      <td>{date(r.out_date)}</td>
                      <td>{r.out_doc_number ?? '-'}</td>
                      <td>{end ? <span className={end < new Date() ? 'text-bad' : 'text-ok'}>until {date(end.toISOString().slice(0, 10))}</span> : r.warranty_months ? `${r.warranty_months} months` : '-'}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </Card>
  )
}

import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Plus, Printer, Save, Trash2, AlertTriangle, Info } from 'lucide-react'
import { api } from '../../api'
import { useApp, useCan } from '../../store'
import { Badge, Button, Card, Checkbox, Field, IconButton, Input, Loading, Modal, NumberInput, Select, Textarea, cx, toast } from '../../components/ui'
import { Combobox } from '../../components/Combobox'
import { PartyForm } from '../../components/PartyForm'
import { useAccounts, useParties, useProducts, useProjects, useTaxRates, useWarehouses, ProductLite } from '../../lib/hooks'
import { addDays, money, qty as fmtQty, today } from '../../lib/format'
import { computeTotals } from '@shared/totals'
import { amountInWords } from '@shared/money'
import { DOC_TYPES, DocType, PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from '@shared/docTypes'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Line {
  key: string
  productId: number | null
  /** Item name / line title (printed in bold) */
  description: string
  /** Item description printed under the name (multi-line, optional) */
  details: string
  /** Description last filled in from the product (so a product change only replaces untouched text) */
  autoDetails: string
  /** Description box opened by the user (it is always shown when the line has a description) */
  showDetails: boolean
  unit: string
  qty: number
  rate: number
  discountPct: number
  taxRate: number
  serials: string
  warranty: string
  batchNo: string
  refLineId: number | null
}

let seq = 0
const newLine = (): Line => ({ key: `l${++seq}`, productId: null, description: '', details: '', autoDetails: '', showDetails: false, unit: '', qty: 1, rate: 0, discountPct: 0, taxRate: 0, serials: '', warranty: '', batchNo: '', refLineId: null })

function fromInput(l: any): Line {
  return {
    key: `l${++seq}`,
    productId: l.productId ?? l.product_id ?? null,
    description: l.description ?? '',
    details: l.details ?? '',
    autoDetails: '',
    showDetails: false,
    unit: l.unit ?? '',
    qty: Number(l.qty) || 0,
    rate: Number(l.rate) || 0,
    discountPct: Number(l.discountPct ?? l.discount_pct) || 0,
    taxRate: Number(l.taxRate ?? l.tax_rate) || 0,
    serials: l.serials ?? '',
    warranty: l.warranty ?? '',
    batchNo: l.batchNo ?? l.batch_no ?? '',
    refLineId: l.refLineId ?? l.ref_line_id ?? null
  }
}

export function DocumentEditor(): JSX.Element {
  const { type: typeParam, id } = useParams()
  const [params] = useSearchParams()
  const nav = useNavigate()
  const can = useCan()
  const settings = useApp((s) => s.settings)
  const [docType, setDocType] = useState<DocType>((typeParam as DocType) || 'sale_invoice')
  const meta = DOC_TYPES[docType]
  const isSales = meta.side === 'sales'
  const [loaded, setLoaded] = useState(false)
  const [h, setH] = useState<any>({})
  const [lines, setLines] = useState<Line[]>([newLine()])
  const [payment, setPayment] = useState<any>({ amount: 0, accountId: null, method: 'cash', reference: '' })
  const [applyAdvance, setApplyAdvance] = useState(true)
  const [busy, setBusy] = useState(false)
  const [number, setNumber] = useState<string | null>(null)
  const [partyModal, setPartyModal] = useState<{ open: boolean; name?: string }>({ open: false })
  const [productModal, setProductModal] = useState<{ open: boolean; name?: string; lineKey?: string }>({ open: false })

  const { products, options: productOptions, reload: reloadProducts } = useProducts()
  const { parties, options: partyOptions, reload: reloadParties } = useParties(meta?.partyType)
  const { projects, options: projectOptions } = useProjects()
  const warehouses = useWarehouses()
  const accounts = useAccounts()
  const taxRates = useTaxRates()
  const productMap = useMemo(() => new Map(products.map((p) => [p.id, p])), [products])

  // Load existing / conversion / defaults
  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        if (id) {
          const d = await api<any>('docs.get', { id: Number(id) })
          setDocType(d.doc_type)
          setNumber(d.number)
          setH({
            id: d.id,
            date: d.date,
            dueDate: d.due_date ?? '',
            validUntil: d.valid_until ?? '',
            partyId: d.party_id,
            partyName: d.party_id ? '' : (d.party_name ?? ''),
            partyPhone: d.party_id ? '' : (d.party_phone ?? ''),
            partyAddress: d.party_id ? '' : (d.party_address ?? ''),
            projectId: d.project_id,
            warehouseId: d.warehouse_id,
            isTaxInvoice: !!d.is_tax_invoice,
            deductStock: !!d.deduct_stock,
            directToProject: !!d.direct_to_project,
            docDiscount: d.doc_discount,
            otherCharges: d.other_charges,
            otherChargesLabel: d.other_charges_label ?? '',
            roundOff: d.round_off,
            refDocId: d.ref_doc_id,
            partyRef: d.party_ref ?? '',
            notes: d.notes ?? '',
            terms: d.terms ?? '',
            status: d.status
          })
          setLines(d.lines.map(fromInput))
        } else {
          const t = (typeParam as DocType) || 'sale_invoice'
          const from = params.get('from')
          const copy = params.get('copy')
          if (copy) {
            const c = await api<any>('docs.copy', { id: Number(copy) })
            setH({ ...c, dueDate: c.dueDate ?? '', validUntil: t === 'quotation' ? addDays(today(), 7) : (c.validUntil ?? ''), partyRef: '', notes: c.notes ?? '', terms: c.terms ?? '', status: t === 'quotation' ? 'draft' : undefined })
            setLines(c.lines.length ? c.lines.map(fromInput) : [newLine()])
          } else if (from) {
            const c = await api<any>('docs.convert', { id: Number(from), target: t })
            setH({ ...c, dueDate: c.dueDate ?? '', validUntil: c.validUntil ?? '', partyRef: '', notes: c.notes ?? '', terms: c.terms ?? defaultTerms(t), deductStock: c.deductStock ?? true, directToProject: false })
            setLines(c.lines.length ? c.lines.map(fromInput) : [newLine()])
          } else {
            const projectId = params.get('project') ? Number(params.get('project')) : null
            const partyId = params.get('party') ? Number(params.get('party')) : null
            setH({
              date: today(),
              dueDate: t === 'sale_invoice' || t === 'purchase_invoice' ? '' : '',
              validUntil: t === 'quotation' ? addDays(today(), 7) : '',
              partyId,
              projectId,
              isTaxInvoice: false,
              deductStock: true,
              directToProject: false,
              docDiscount: 0,
              otherCharges: 0,
              otherChargesLabel: '',
              roundOff: 0,
              notes: '',
              terms: defaultTerms(t),
              status: t === 'quotation' ? 'draft' : undefined
            })
          }
        }
        setLoaded(true)
      } catch (e) {
        toast.error(e)
        nav(-1)
      }
    }
    load()
  }, [id, typeParam, params.get('copy'), params.get('from')]) // eslint-disable-line react-hooks/exhaustive-deps

  function defaultTerms(t: DocType): string {
    if (t === 'quotation') return settings.default_quotation_terms ?? ''
    if (t === 'sale_invoice' || t === 'sale_order') return settings.default_invoice_terms ?? ''
    return ''
  }

  // default warehouse & account
  useEffect(() => {
    if (loaded && !h.warehouseId && warehouses.length) setH((x: any) => ({ ...x, warehouseId: (warehouses.find((w) => w.is_default) ?? warehouses[0]).id }))
  }, [loaded, warehouses]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!payment.accountId && accounts.length) setPayment((p: any) => ({ ...p, accountId: (accounts.find((a) => a.is_default) ?? accounts[0]).id }))
  }, [accounts]) // eslint-disable-line react-hooks/exhaustive-deps

  // Project-linked sales invoices default to not deducting stock only when the project already has issued materials — keep explicit
  const project = projects.find((p) => p.id === h.projectId)
  const party = parties.find((p) => p.id === h.partyId)

  const computed = useMemo(() => computeTotals(lines, h.docDiscount, h.otherCharges, h.roundOff), [lines, h.docDiscount, h.otherCharges, h.roundOff])
  const t = computed.totals

  const setLine = (key: string, patch: Partial<Line>): void => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))

  /** Fills the item description from the product, unless the user already typed their own text on that line. */
  const fillDetails = async (key: string, productId: number): Promise<void> => {
    try {
      const [info] = await api<Array<{ id: number; description: string | null }>>('docs.productDetails', { ids: [productId] })
      const text = (info?.description ?? '').trim()
      setLines((ls) =>
        ls.map((l) => {
          if (l.key !== key || l.productId !== productId) return l
          const untouched = !l.details.trim() || l.details === l.autoDetails
          return untouched ? { ...l, details: text, autoDetails: text } : l
        })
      )
    } catch (e) {
      toast.error(e)
    }
  }

  const pickProduct = (key: string, p: ProductLite | undefined): void => {
    if (!p) return setLine(key, { productId: null })
    const warranty = isSales && p.warranty_months ? (p.warranty_months % 12 === 0 ? `${p.warranty_months / 12} Year${p.warranty_months === 12 ? '' : 's'}` : `${p.warranty_months} Months`) : ''
    setLine(key, {
      productId: p.id,
      description: p.name,
      unit: p.unit,
      rate: isSales ? p.sale_price : (p.purchase_price ?? p.avg_cost ?? 0),
      taxRate: p.tax_rate,
      warranty
    })
    void fillDetails(key, p.id)
  }

  const stockAffecting = meta.stock !== 0 && !((docType === 'sale_invoice' || docType === 'sale_return') && !h.deductStock) && !(docType === 'purchase_invoice' && h.directToProject)

  const save = async (andPrint = false): Promise<void> => {
    setBusy(true)
    try {
      const payload = {
        ...h,
        id: h.id,
        docType,
        dueDate: h.dueDate || null,
        validUntil: h.validUntil || null,
        lines: lines
          .filter((l) => l.productId || l.description.trim())
          .map((l) => ({ productId: l.productId, description: l.description, details: l.details, unit: l.unit, qty: l.qty, rate: l.rate, discountPct: l.discountPct, taxRate: l.taxRate, serials: l.serials, warranty: l.warranty, batchNo: l.batchNo, refLineId: l.refLineId })),
        payment: meta.financial && payment.amount > 0 ? payment : null,
        applyAdvance: meta.financial && applyAdvance
      }
      const savedId = await api<number>(h.id ? 'docs.update' : 'docs.create', payload)
      toast.ok(`${meta.label} saved.`)
      if (andPrint) api('print.open', { kind: 'doc', id: savedId }).catch(toast.error)
      nav(`/doc/${savedId}`, { replace: true })
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const k = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        saveRef.current()
      }
    }
    window.addEventListener('keydown', k)
    return () => window.removeEventListener('keydown', k)
  }, [])

  if (!loaded || !meta) return <Loading />

  const showTax = lines.some((l) => l.taxRate > 0) || h.isTaxInvoice || taxRates.some((r) => r.rate > 0)
  const canDiscount = !isSales || can('sales.discount')
  const sym = settings.currency_symbol ?? 'Rs.'

  return (
    <div className="pb-24">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <IconButton title="Back" onClick={() => nav(-1)}>
          <ArrowLeft className="h-5 w-5" />
        </IconButton>
        <div>
          <h1 className="text-[20px] font-bold">{h.id ? `Edit ${meta.label}` : `New ${meta.label}`}</h1>
          <div className="text-[12.5px] text-muted">{number ? `Number ${number}` : 'Number is assigned automatically when saved'} · Ctrl+S to save</div>
        </div>
        {h.refDocId && <Badge tone="info">Linked to a source document</Badge>}
      </div>

      <Card className="mb-4">
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Field label={meta.partyType === 'customer' ? 'Customer' : 'Supplier'} className="col-span-2" required={!isSales || docType === 'sale_return'}>
            <Combobox
              options={partyOptions}
              value={h.partyId}
              onChange={(v) => {
                const p = parties.find((x) => x.id === v)
                setH({ ...h, partyId: v, dueDate: p?.payment_terms_days && (docType === 'sale_invoice' || docType === 'purchase_invoice') ? addDays(h.date, p.payment_terms_days) : h.dueDate })
              }}
              placeholder={isSales ? 'Walk-in customer (select or create)' : 'Select supplier'}
              allowClear
              onCreate={can(meta.partyType === 'customer' ? 'customers.manage' : 'suppliers.manage') ? (name) => setPartyModal({ open: true, name }) : undefined}
              createLabel={`New ${meta.partyType}`}
            />
            {party && (
              <div className="mt-1 text-[12px] text-muted">
                {party.phone} {party.city ? `· ${party.city}` : ''} · Balance:{' '}
                <span className={party.balance > 0 ? 'font-semibold text-bad' : party.balance < 0 ? 'font-semibold text-ok' : ''}>
                  {money(party.balance)} {party.balance > 0 ? '(receivable)' : party.balance < 0 ? (meta.partyType === 'customer' ? '(advance)' : '(payable)') : ''}
                </span>
                {party.credit_limit > 0 && party.balance + t.grandTotal > party.credit_limit && <span className="ml-2 font-semibold text-warn">Over credit limit ({money(party.credit_limit)})</span>}
              </div>
            )}
          </Field>
          <Field label="Date" required>
            <Input type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} />
          </Field>
          {docType === 'quotation' ? (
            <Field label="Valid until">
              <Input type="date" value={h.validUntil} onChange={(e) => setH({ ...h, validUntil: e.target.value })} />
            </Field>
          ) : meta.financial && !docType.includes('return') ? (
            <Field label="Due date">
              <Input type="date" value={h.dueDate} onChange={(e) => setH({ ...h, dueDate: e.target.value })} />
            </Field>
          ) : (
            <div />
          )}
          {isSales && !h.partyId && (
            <>
              <Field label="Customer name (walk-in)">
                <Input value={h.partyName ?? ''} onChange={(e) => setH({ ...h, partyName: e.target.value })} placeholder="Walk-in Customer" />
              </Field>
              <Field label="Phone">
                <Input value={h.partyPhone ?? ''} onChange={(e) => setH({ ...h, partyPhone: e.target.value })} />
              </Field>
              <Field label="Address" className="col-span-2">
                <Input value={h.partyAddress ?? ''} onChange={(e) => setH({ ...h, partyAddress: e.target.value })} />
              </Field>
            </>
          )}
          <Field label="Solar project (optional)" className="col-span-2">
            <Combobox
              options={projectOptions}
              value={h.projectId}
              onChange={(v) => {
                const pr = projects.find((p) => p.id === v)
                setH({ ...h, projectId: v, partyId: isSales && pr?.customer_id && !h.partyId ? pr.customer_id : h.partyId })
              }}
              placeholder="Not linked to a project"
              allowClear
            />
          </Field>
          {meta.stock !== 0 && (
            <Field label="Warehouse">
              <Select value={h.warehouseId ?? ''} onChange={(e) => setH({ ...h, warehouseId: Number(e.target.value) })}>
                {warehouses.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                    {w.firm_id === null ? ' (shared)' : ''}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label={isSales ? 'Customer PO / reference' : 'Supplier invoice no.'}>
            <Input value={h.partyRef ?? ''} onChange={(e) => setH({ ...h, partyRef: e.target.value })} />
          </Field>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-line pt-3 text-[13px]">
          {(docType === 'sale_invoice' || docType === 'quotation' || docType === 'sale_order') && (
            <Checkbox checked={!!h.isTaxInvoice} onChange={(v) => setH({ ...h, isTaxInvoice: v })} label="Sales Tax Invoice format" />
          )}
          {docType === 'sale_invoice' && (
            <Checkbox checked={!!h.deductStock} onChange={(v) => setH({ ...h, deductStock: v })} label="Deduct items from stock" />
          )}
          {docType === 'purchase_invoice' && h.projectId && (
            <Checkbox checked={!!h.directToProject} onChange={(v) => setH({ ...h, directToProject: v })} label="Delivered directly to project site (do not add to stock; charge cost to project)" />
          )}
          {docType === 'quotation' && (
            <label className="flex items-center gap-2">
              Status
              <Select sm className="w-32" value={h.status ?? 'draft'} onChange={(e) => setH({ ...h, status: e.target.value })}>
                {['draft', 'sent', 'accepted', 'rejected'].map((s) => (
                  <option key={s} value={s}>{s[0].toUpperCase() + s.slice(1)}</option>
                ))}
              </Select>
            </label>
          )}
        </div>
        {docType === 'sale_invoice' && h.projectId && (
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-info-soft px-3 py-2 text-[12.5px] text-info">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />
            <span>
              Project invoice for <b>{project?.name}</b>. If materials were already issued to this project from <i>Solar Projects → Issue Materials</i>, untick
              “Deduct items from stock” so the same items are not deducted (and costed) twice.
            </span>
          </div>
        )}
      </Card>

      <Card pad={false} className="mb-4">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 34 }}>#</th>
                <th style={{ minWidth: 300 }}>Item / description</th>
                <th style={{ width: 90 }} className="text-right">Qty</th>
                <th style={{ width: 70 }}>Unit</th>
                <th style={{ width: 120 }} className="text-right">Rate</th>
                {canDiscount && <th style={{ width: 80 }} className="text-right">Disc %</th>}
                {showTax && <th style={{ width: 80 }} className="text-right">Tax %</th>}
                <th style={{ width: 130 }} className="text-right">Amount</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => {
                const p = l.productId ? productMap.get(l.productId) : undefined
                const c = computed.lines[i]
                const short = isSales && stockAffecting && p && p.type === 'goods' && l.qty > p.stock
                const belowCost = isSales && p && p.avg_cost !== null && p.avg_cost > 0 && l.rate > 0 && l.rate < p.avg_cost
                return (
                  <tr key={l.key} className="align-top">
                    <td className="pt-3 text-muted">{i + 1}</td>
                    <td>
                      <div className="space-y-1.5">
                        <Combobox
                          sm
                          options={productOptions}
                          value={l.productId}
                          onChange={(v) => pickProduct(l.key, products.find((x) => x.id === v))}
                          placeholder="Select product / service (or type a description below)"
                          allowClear
                          onCreate={can('inventory.manage') ? (name) => setProductModal({ open: true, name, lineKey: l.key }) : undefined}
                          createLabel="New product"
                        />
                        <Input sm aria-label="Item name" className="font-medium" value={l.description} onChange={(e) => setLine(l.key, { description: e.target.value })} placeholder="Item name printed on the document (bold)" />
                        {l.showDetails || l.details ? (
                          <Textarea
                            aria-label="Item description"
                            rows={Math.min(6, Math.max(2, l.details.split('\n').length))}
                            className="min-h-0 py-1.5 text-[12.5px] leading-snug"
                            value={l.details}
                            onChange={(e) => setLine(l.key, { details: e.target.value })}
                            placeholder="Item description (optional) — printed under the item name, e.g. specifications, model details, scope of work"
                          />
                        ) : (
                          <button type="button" className="flex items-center gap-1 text-[12px] font-medium text-brand hover:underline cursor-pointer" onClick={() => setLine(l.key, { showDetails: true })}>
                            <Plus className="h-3.5 w-3.5" /> Add item description
                          </button>
                        )}
                        {(p?.track_serial || l.serials) && stockAffecting ? (
                          <Input sm value={l.serials} onChange={(e) => setLine(l.key, { serials: e.target.value })} placeholder={`Serial numbers (comma separated)${p?.track_serial ? ` — ${l.qty} required` : ''}`} />
                        ) : null}
                        {isSales && (l.warranty || p?.warranty_months) ? (
                          <Input sm value={l.warranty} onChange={(e) => setLine(l.key, { warranty: e.target.value })} placeholder="Warranty (e.g. 12 Years)" />
                        ) : null}
                        {p && (
                          <div className="flex flex-wrap gap-3 text-[11.5px] text-muted">
                            {p.type === 'goods' && <span className={short ? 'font-semibold text-bad' : ''}>In stock: {fmtQty(p.stock)} {p.unit}{short && ' — not enough stock'}</span>}
                            {p.avg_cost !== null && p.type === 'goods' && <span>Avg cost: {money(p.avg_cost)}</span>}
                            {belowCost && <span className="font-semibold text-warn"><AlertTriangle className="inline h-3 w-3" /> Below cost</span>}
                          </div>
                        )}
                      </div>
                    </td>
                    <td><NumberInput sm value={l.qty} onChange={(v) => setLine(l.key, { qty: v })} /></td>
                    <td><Input sm value={l.unit} onChange={(e) => setLine(l.key, { unit: e.target.value })} /></td>
                    <td><NumberInput sm value={l.rate} onChange={(v) => setLine(l.key, { rate: v })} /></td>
                    {canDiscount && <td><NumberInput sm value={l.discountPct} onChange={(v) => setLine(l.key, { discountPct: v })} /></td>}
                    {showTax && (
                      <td>
                        <Select sm value={String(l.taxRate)} onChange={(e) => setLine(l.key, { taxRate: Number(e.target.value) })}>
                          {Array.from(new Set([0, ...taxRates.map((r) => r.rate), l.taxRate])).sort((a, b) => a - b).map((r) => (
                            <option key={r} value={r}>{r}%</option>
                          ))}
                        </Select>
                      </td>
                    )}
                    <td className="num pt-3 text-right font-semibold">
                      {money(c?.total ?? 0)}
                      {c && c.discount > 0 && <div className="text-[11px] font-normal text-muted">disc {money(c.discount)}</div>}
                    </td>
                    <td className="pt-2">
                      <IconButton title="Remove line" tone="bad" onClick={() => setLines((ls) => (ls.length > 1 ? ls.filter((x) => x.key !== l.key) : [newLine()]))}>
                        <Trash2 className="h-4 w-4" />
                      </IconButton>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-2 border-t border-line px-4 py-2.5">
          <Button size="sm" variant="soft" icon={<Plus className="h-4 w-4" />} onClick={() => setLines((ls) => [...ls, newLine()])}>
            Add line
          </Button>
          <span className="text-[12px] text-muted">{lines.length} line(s)</span>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <Card title="Notes & terms">
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              <Field label="Notes (printed)">
                <Textarea rows={4} value={h.notes ?? ''} onChange={(e) => setH({ ...h, notes: e.target.value })} />
              </Field>
              <Field label="Terms & conditions (printed)">
                <Textarea rows={4} value={h.terms ?? ''} onChange={(e) => setH({ ...h, terms: e.target.value })} />
              </Field>
            </div>
          </Card>
          {meta.financial && can('accounts.manage') && (
            <Card title={docType === 'sale_invoice' || docType === 'purchase_return' ? 'Payment received now' : 'Payment made now'}>
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Field label="Amount">
                  <div className="flex gap-1">
                    <NumberInput value={payment.amount} onChange={(v) => setPayment({ ...payment, amount: v })} />
                    <Button size="sm" className="h-9" onClick={() => setPayment({ ...payment, amount: t.grandTotal })}>Full</Button>
                  </div>
                </Field>
                <Field label="Account">
                  <Select value={payment.accountId ?? ''} onChange={(e) => setPayment({ ...payment, accountId: Number(e.target.value) })}>
                    {accounts.map((a) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Method">
                  <Select value={payment.method} onChange={(e) => setPayment({ ...payment, method: e.target.value })}>
                    {PAYMENT_METHODS.map((m) => (
                      <option key={m} value={m}>{PAYMENT_METHOD_LABELS[m]}</option>
                    ))}
                  </Select>
                </Field>
                <Field label="Reference">
                  <Input value={payment.reference} onChange={(e) => setPayment({ ...payment, reference: e.target.value })} />
                </Field>
              </div>
              {h.partyId && (
                <div className="mt-3">
                  <Checkbox checked={applyAdvance} onChange={setApplyAdvance} label="Apply any advance / on-account payments of this party to this document" />
                </div>
              )}
            </Card>
          )}
        </div>
        <Card title="Summary">
          <div className="space-y-1 text-[13.5px]">
            <Row label="Subtotal" value={money(t.subtotal)} />
            {t.lineDiscountTotal > 0 && <Row label="Line discounts" value={`- ${money(t.lineDiscountTotal)}`} />}
            {canDiscount && (
              <div className="flex items-center justify-between gap-3 py-1">
                <span className="text-muted">Discount ({sym})</span>
                <NumberInput sm className="w-32" value={h.docDiscount} onChange={(v) => setH({ ...h, docDiscount: v })} />
              </div>
            )}
            <div className="flex items-center justify-between gap-2 py-1">
              <Input sm className="w-40" value={h.otherChargesLabel ?? ''} onChange={(e) => setH({ ...h, otherChargesLabel: e.target.value })} placeholder={isSales ? 'Freight / other charges' : 'Freight / loading'} />
              <NumberInput sm className="w-32" value={h.otherCharges} onChange={(v) => setH({ ...h, otherCharges: v })} />
            </div>
            {t.taxTotal !== 0 && <Row label="Sales tax" value={money(t.taxTotal, { decimals: 2 })} />}
            <div className="flex items-center justify-between gap-3 py-1">
              <span className="text-muted">Round off</span>
              <NumberInput sm className="w-32" value={h.roundOff} onChange={(v) => setH({ ...h, roundOff: v })} />
            </div>
            <div className="my-2 border-t border-line" />
            <div className="flex items-baseline justify-between">
              <span className="font-semibold">Grand total</span>
              <span className="num text-[22px] font-bold text-brand">{money(t.grandTotal)}</span>
            </div>
            <div className="text-[11.5px] text-muted">{amountInWords(t.grandTotal, settings.currency_word ?? 'Rupees')}</div>
            {meta.financial && payment.amount > 0 && (
              <>
                <Row label="Paid now" value={money(payment.amount)} />
                <Row label="Balance" value={<span className="font-semibold text-bad">{money(t.grandTotal - payment.amount)}</span>} />
              </>
            )}
          </div>
        </Card>
      </div>

      <div className="fixed right-0 bottom-0 left-[232px] z-20 flex items-center justify-end gap-2 border-t border-line bg-surface/95 px-6 py-3 backdrop-blur">
        <span className="mr-auto text-[13px] text-muted">
          {meta.label} · {lines.filter((l) => l.productId || l.description).length} item(s) · <b className="text-ink">{money(t.grandTotal)}</b>
        </span>
        <Button onClick={() => nav(-1)}>Cancel</Button>
        <Button loading={busy} onClick={() => save(true)} icon={<Printer className="h-4 w-4" />}>
          Save & Print
        </Button>
        <Button variant="primary" loading={busy} onClick={() => save(false)} icon={<Save className="h-4 w-4" />}>
          Save {meta.label}
        </Button>
      </div>

      <PartyForm
        open={partyModal.open}
        type={meta.partyType}
        initialName={partyModal.name}
        onClose={() => setPartyModal({ open: false })}
        onSaved={async (pid) => {
          await reloadParties()
          setH((x: any) => ({ ...x, partyId: pid }))
        }}
      />
      <QuickProduct
        open={productModal.open}
        name={productModal.name}
        sales={isSales}
        onClose={() => setProductModal({ open: false })}
        onSaved={async (pid, p) => {
          await reloadProducts()
          if (productModal.lineKey) {
            setLine(productModal.lineKey, { productId: pid, description: p.name, unit: p.unit, rate: isSales ? p.salePrice : p.purchasePrice })
            void fillDetails(productModal.lineKey, pid)
          }
        }}
      />
    </div>
  )
}

function Row({ label, value }: { label: string; value: React.ReactNode }): JSX.Element {
  return (
    <div className="flex items-center justify-between gap-3 py-1">
      <span className="text-muted">{label}</span>
      <span className="num font-medium">{value}</span>
    </div>
  )
}

function QuickProduct({ open, name, sales, onClose, onSaved }: { open: boolean; name?: string; sales: boolean; onClose: () => void; onSaved: (id: number, p: any) => void }): JSX.Element {
  const [f, setF] = useState<any>({})
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setF({ name: name ?? '', type: 'goods', unit: 'pcs', salePrice: 0, purchasePrice: 0 })
  }, [open, name])
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const id = await api<number>('products.save', f)
      toast.ok('Product created.')
      onSaved(id, f)
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal open={open} onClose={onClose} title="Quick add product" size="sm" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Create</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name" className="col-span-2"><Input autoFocus value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
        <Field label="Type">
          <Select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, unit: e.target.value === 'service' ? 'job' : 'pcs' })}>
            <option value="goods">Goods (stock item)</option>
            <option value="service">Service / labor</option>
          </Select>
        </Field>
        <Field label="Unit"><Input value={f.unit ?? ''} onChange={(e) => setF({ ...f, unit: e.target.value })} /></Field>
        <Field label="Sale price"><NumberInput value={f.salePrice} onChange={(v) => setF({ ...f, salePrice: v })} /></Field>
        <Field label="Purchase price"><NumberInput value={f.purchasePrice} onChange={(v) => setF({ ...f, purchasePrice: v })} /></Field>
      </div>
      <div className={cx('mt-3 text-[12px] text-muted', sales && 'hidden')}>Full details (category, warranty, serial tracking) can be added later in Inventory.</div>
    </Modal>
  )
}

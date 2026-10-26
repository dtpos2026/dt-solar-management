/**
 * Point of sale counter: scan or search items, a cart, hold bills, take cash / card / split payment with change, print the
 * receipt, cash drawer shift with a count at the end. Every sale is an ordinary sales invoice made by services/pos.ts.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Banknote, Clock, Pause, Plus, Minus, Printer, Receipt, ScanBarcode, Store, Trash2, Undo2, Wallet, X } from 'lucide-react'
import { api } from '../../api'
import { useApp, useCan } from '../../store'
import { Badge, Button, Card, Empty, Field, Input, Loading, Modal, NumberInput, Select, Textarea, confirmDialog, cx, toast } from '../../components/ui'
import { Combobox } from '../../components/Combobox'
import { PartyForm } from '../../components/PartyForm'
import { useLoad, useParties, useProducts, ProductLite } from '../../lib/hooks'
import { money, qty as fmtQty, dateTime } from '../../lib/format'
import { computeTotals } from '@shared/totals'
import { autoRoundOff } from '@shared/options'
import { posOption } from '@shared/modules'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface CartLine {
  key: string
  productId: number | null
  name: string
  unit: string
  qty: number
  rate: number
  listRate: number
  discountPct: number
  taxRate: number
  stock: number | null
}
interface Tender {
  key: string
  method: 'cash' | 'card' | 'bank_transfer' | 'online'
  amount: number
}
const METHOD_LABEL: Record<string, string> = { cash: 'Cash', card: 'Card', bank_transfer: 'Bank transfer', online: 'Online / wallet' }

let seq = 0
const nextKey = (): string => `k${++seq}`
// The cart survives a trip to another screen (held bills survive a restart).
let savedCart: { lines: CartLine[]; partyId: number | null; docDiscount: number } = { lines: [], partyId: null, docDiscount: 0 }

export function PosPage(): JSX.Element {
  const nav = useNavigate()
  const can = useCan()
  const settings = useApp((s) => s.settings)
  const opt = (k: string): boolean | string => posOption(settings, k)
  const [tick, setTick] = useState(0)
  const st = useLoad(() => api<any>('pos.status'), [tick])
  const { products } = useProducts()
  const { options: partyOptions, reload: reloadParties } = useParties('customer')
  const [lines, setLines] = useState<CartLine[]>(savedCart.lines)
  const [partyId, setPartyId] = useState<number | null>(savedCart.partyId)
  const [docDiscount, setDocDiscount] = useState(savedCart.docDiscount)
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('')
  const [pay, setPay] = useState(false)
  const [holdsOpen, setHoldsOpen] = useState(false)
  const [recentOpen, setRecentOpen] = useState(false)
  const [shiftsOpen, setShiftsOpen] = useState(false)
  const [reportOpen, setReportOpen] = useState(false)
  const [closeOpen, setCloseOpen] = useState(false)
  const [moveOpen, setMoveOpen] = useState(false)
  const [newCust, setNewCust] = useState<{ open: boolean; name?: string }>({ open: false })
  const [done, setDone] = useState<null | { id: number; number: string; total: number; paid: number; change: number; due: number }>(null)
  const [holdId, setHoldId] = useState<number | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    savedCart = { lines, partyId, docDiscount }
  }, [lines, partyId, docDiscount])

  const shift = st.data?.shift ?? null
  const needShift = opt('require_shift') === true
  const allowDiscount = opt('allow_discount') === true && can('sales.discount')
  const priceEdit = opt('allow_price_change') === true
  const showStock = opt('show_stock') === true
  const roundTo = String(opt('round_to'))

  const totals = useMemo(() => {
    const pre = computeTotals(lines, docDiscount, 0, 0).totals
    const roundOff = roundTo === 'off' ? 0 : autoRoundOff(pre.grandTotal, 'nearest', Number(roundTo))
    return { ...pre, roundOff, total: Math.round((pre.grandTotal + roundOff) * 100) / 100 }
  }, [lines, docDiscount, roundTo])

  const add = (p: ProductLite, n = 1): void => {
    setLines((ls) => {
      const same = ls.find((l) => l.productId === p.id)
      if (same) return ls.map((l) => (l.key === same.key ? { ...l, qty: Math.round((l.qty + n) * 1000) / 1000 } : l))
      return [...ls, { key: nextKey(), productId: p.id, name: p.name, unit: p.unit, qty: n, rate: p.sale_price, listRate: p.sale_price, discountPct: 0, taxRate: p.tax_rate, stock: p.type === 'goods' ? p.stock : null }]
    })
  }
  const setLine = (key: string, patch: Partial<CartLine>): void => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)))
  const clear = (): void => {
    setLines([])
    setDocDiscount(0)
    setPartyId(null)
    setHoldId(null)
    setTimeout(() => searchRef.current?.focus(), 0)
  }

  // search: a barcode / item code / exact name adds at once on Enter; one match adds too
  const needle = q.trim().toLowerCase()
  const matches = useMemo(() => {
    return products
      .filter((p) => p.is_active)
      .filter((p) => !cat || (p.category_name ?? 'Other') === cat)
      .filter((p) => !needle || `${p.name} ${p.sku ?? ''} ${p.barcode ?? ''} ${p.brand ?? ''} ${p.model ?? ''}`.toLowerCase().includes(needle))
      .slice(0, 90)
  }, [products, needle, cat])
  const categories = useMemo(() => Array.from(new Set(products.filter((p) => p.is_active).map((p) => p.category_name ?? 'Other'))).sort(), [products])
  const onSearchEnter = (): void => {
    if (!needle) return
    const exact = products.find((p) => p.is_active && ((p.barcode ?? '').toLowerCase() === needle || (p.sku ?? '').toLowerCase() === needle))
    const one = exact ?? (matches.length === 1 ? matches[0] : undefined)
    if (!one) return toast.error(matches.length ? 'Several items match. Tap the one you want.' : `No item matches "${q.trim()}".`)
    add(one)
    setQ('')
  }

  // keyboard: F2 search, F4 hold, F8 pay, F9 clear
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => undefined)
  keyRef.current = (e) => {
    if (e.key === 'F2') (e.preventDefault(), searchRef.current?.focus())
    else if (e.key === 'F4') (e.preventDefault(), void hold())
    else if (e.key === 'F8') (e.preventDefault(), openPay())
    else if (e.key === 'F9') (e.preventDefault(), void clearAsk())
  }
  useEffect(() => {
    const h = (e: KeyboardEvent): void => keyRef.current(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  const openPay = (): void => {
    if (!lines.length) return toast.error('The cart is empty.')
    if (needShift && !shift) return toast.error('Open a shift first.')
    setPay(true)
  }
  const clearAsk = async (): Promise<void> => {
    if (!lines.length) return
    if (await confirmDialog({ title: 'Clear the cart?', message: 'All items on this bill are removed.', danger: true, confirmLabel: 'Clear' })) clear()
  }
  const hold = async (): Promise<void> => {
    if (!lines.length) return
    try {
      if (holdId) await api('pos.deleteHold', { id: holdId })
      await api('pos.hold', { label: partyId ? (partyOptions.find((o) => o.value === partyId)?.label ?? '') : '', cart: { lines, partyId, docDiscount }, total: totals.total })
      toast.ok('Bill held. Resume it from "Held bills".')
      clear()
      setTick((t) => t + 1)
    } catch (e) {
      toast.error(e)
    }
  }

  const printReceipt = (id: number, auto = false): void => {
    const thermal = opt('receipt') === 'thermal80'
    api('print.open', { kind: 'doc', id, params: { paper: thermal ? 'thermal80' : undefined, template: thermal ? 'builtin:thermal80' : undefined, autoprint: auto ? '1' : undefined } }).catch(toast.error)
  }

  if (st.loading && !st.data) return <Loading />
  if (!st.data?.enabled) return <Empty icon={<Store />} title="POS is switched off">Switch it on in Settings, Simple / Customize, under POS and ERP modules.</Empty>

  const lineTotal = (l: CartLine): number => computeTotals([l], 0, 0, 0).totals.grandTotal

  return (
    <div className="flex h-[calc(100vh-150px)] min-h-[560px] flex-col gap-3">
      {/* shift bar */}
      <Card pad={false}>
        <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[13px]">
          <Store className="h-5 w-5 text-brand" />
          <span className="text-[16px] font-bold">POS Counter</span>
          {shift ? (
            <>
              <Badge tone="ok">Shift open since {dateTime(shift.shift.opened_at)}</Badge>
              <span className="text-muted">
                {shift.sales.count} sale(s), <b className="text-ink">{money(shift.sales.total)}</b>, drawer should hold <b className="text-ink">{money(shift.cash.expected)}</b>
              </span>
            </>
          ) : (
            <Badge tone={needShift ? 'warn' : 'muted'}>{needShift ? 'No shift open' : 'No shift (not required)'}</Badge>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button size="sm" icon={<Pause className="h-4 w-4" />} onClick={() => setHoldsOpen(true)}>Held bills{st.data.holds ? ` (${st.data.holds})` : ''}</Button>
            <Button size="sm" icon={<Receipt className="h-4 w-4" />} onClick={() => setRecentOpen(true)}>Recent sales</Button>
            {can('pos.shift') && shift && <Button size="sm" icon={<Banknote className="h-4 w-4" />} onClick={() => setMoveOpen(true)}>Cash in / out</Button>}
            {can('pos.shift') && shift && <Button size="sm" onClick={() => setReportOpen(true)}>Shift report</Button>}
            {can('pos.shift') && shift && <Button size="sm" variant="danger" onClick={() => setCloseOpen(true)}>Close shift</Button>}
            {can('pos.shift') && <Button size="sm" onClick={() => setShiftsOpen(true)}>Shifts</Button>}
          </div>
        </div>
      </Card>

      {!shift && needShift ? (
        <OpenShift can={can('pos.shift')} onOpened={() => setTick((t) => t + 1)} />
      ) : (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_460px] gap-3">
          {/* items */}
          <div className="flex min-h-0 flex-col gap-2">
            <div className="relative">
              <ScanBarcode className="pointer-events-none absolute top-1/2 left-3 h-5 w-5 -translate-y-1/2 text-muted" />
              <Input
                ref={searchRef}
                autoFocus
                className="h-11 pl-10 text-[15px]"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), onSearchEnter())}
                placeholder="Scan a barcode or type an item name or code, then Enter (F2)"
                aria-label="Search items"
              />
            </div>
            <div className="flex flex-wrap gap-1.5">
              {['', ...categories].map((c) => (
                <button key={c || 'all'} type="button" onClick={() => setCat(c)} className={cx('rounded-full border px-3 py-1 text-[12.5px] font-medium cursor-pointer', cat === c ? 'border-brand bg-brand text-white' : 'border-line bg-surface hover:border-brand')}>
                  {c || 'All'}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-xl border border-line bg-surface-2 p-2">
              {opt('show_grid') !== true && !needle ? (
                <div className="p-6 text-center text-muted">Type or scan to find an item.</div>
              ) : matches.length === 0 ? (
                <div className="p-6 text-center text-muted">No item found.</div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-2">
                  {matches.map((p) => (
                    <button key={p.id} type="button" onClick={() => add(p)} className="flex min-h-[78px] flex-col justify-between rounded-lg border border-line bg-surface p-2.5 text-left transition hover:border-brand hover:shadow cursor-pointer" data-testid="pos-tile">
                      <span className="line-clamp-2 text-[13px] leading-snug font-semibold">{p.name}</span>
                      <span className="mt-1 flex items-center justify-between gap-2 text-[12px]">
                        <b className="num text-brand">{money(p.sale_price)}</b>
                        {showStock && p.type === 'goods' && <span className={cx('num', p.stock <= 0 ? 'font-semibold text-bad' : 'text-muted')}>{fmtQty(p.stock)} {p.unit}</span>}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* cart */}
          <Card pad={false} className="flex min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-line p-3">
              <div className="min-w-0 flex-1">
                <Combobox sm options={partyOptions} value={partyId} onChange={(v) => setPartyId(v as number | null)} placeholder="Walk-in customer" allowClear onCreate={can('customers.manage') ? (name) => setNewCust({ open: true, name }) : undefined} createLabel="New customer" />
              </div>
              <Button size="sm" icon={<Pause className="h-4 w-4" />} onClick={hold} disabled={!lines.length} title="Hold this bill (F4)">Hold</Button>
              <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={clearAsk} disabled={!lines.length} title="Clear the cart (F9)">Clear</Button>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {lines.length === 0 ? (
                <div className="p-8 text-center text-muted">The cart is empty. Scan or tap an item.</div>
              ) : (
                lines.map((l) => {
                  const short = showStock && l.stock !== null && l.qty > l.stock
                  return (
                    <div key={l.key} className="border-b border-line px-3 py-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="truncate text-[13.5px] font-semibold">{l.name}</div>
                          <div className="text-[12px] text-muted">
                            {priceEdit ? <NumberInput sm className="inline-block w-24" value={l.rate} onChange={(v) => setLine(l.key, { rate: v })} /> : <span className="num">{money(l.rate)}</span>} / {l.unit}
                            {l.rate !== l.listRate && <span className="ml-1 text-warn">(list {money(l.listRate)})</span>}
                          </div>
                          {short && <div className="text-[12px] font-semibold text-bad">Only {fmtQty(l.stock)} in stock</div>}
                        </div>
                        <div className="text-right">
                          <div className="num text-[14px] font-bold">{money(lineTotal(l))}</div>
                          <button type="button" aria-label="Remove item" className="text-muted hover:text-bad cursor-pointer" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}>
                            <X className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                      <div className="mt-1 flex items-center gap-2">
                        <button type="button" aria-label="Less" className="flex h-8 w-8 items-center justify-center rounded-lg border border-line hover:border-brand cursor-pointer" onClick={() => (l.qty <= 1 ? setLines((ls) => ls.filter((x) => x.key !== l.key)) : setLine(l.key, { qty: Math.round((l.qty - 1) * 1000) / 1000 }))}>
                          <Minus className="h-4 w-4" />
                        </button>
                        <NumberInput sm className="w-20" value={l.qty} onChange={(v) => setLine(l.key, { qty: v })} />
                        <button type="button" aria-label="More" className="flex h-8 w-8 items-center justify-center rounded-lg border border-line hover:border-brand cursor-pointer" onClick={() => setLine(l.key, { qty: Math.round((l.qty + 1) * 1000) / 1000 })}>
                          <Plus className="h-4 w-4" />
                        </button>
                        {allowDiscount && (
                          <label className="ml-auto flex items-center gap-1 text-[12px] text-muted">
                            Disc %
                            <NumberInput sm className="w-16" value={l.discountPct} onChange={(v) => setLine(l.key, { discountPct: Math.min(100, Math.max(0, v)) })} />
                          </label>
                        )}
                      </div>
                    </div>
                  )
                })
              )}
            </div>
            <div className="space-y-1 border-t border-line p-3 text-[13.5px]">
              <div className="flex justify-between"><span className="text-muted">Items ({lines.length})</span><span className="num">{money(totals.subtotal)}</span></div>
              {totals.lineDiscountTotal > 0 && <div className="flex justify-between"><span className="text-muted">Line discounts</span><span className="num">- {money(totals.lineDiscountTotal)}</span></div>}
              {allowDiscount && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-muted">Bill discount</span>
                  <NumberInput sm className="w-28" value={docDiscount} onChange={(v) => setDocDiscount(Math.max(0, v))} />
                </div>
              )}
              {totals.taxTotal !== 0 && <div className="flex justify-between"><span className="text-muted">Sales tax</span><span className="num">{money(totals.taxTotal, { decimals: 2 })}</span></div>}
              {totals.roundOff !== 0 && <div className="flex justify-between"><span className="text-muted">Round off</span><span className="num">{money(totals.roundOff, { decimals: 2 })}</span></div>}
              <div className="flex items-baseline justify-between pt-1">
                <span className="text-[15px] font-semibold">Total</span>
                <span className="num text-[26px] font-extrabold text-brand" data-testid="pos-total">{money(totals.total)}</span>
              </div>
              <Button variant="primary" className="mt-1 h-12 w-full text-[16px]" icon={<Wallet className="h-5 w-5" />} onClick={openPay} disabled={!lines.length} data-testid="pos-pay">
                Pay (F8)
              </Button>
            </div>
          </Card>
        </div>
      )}

      {pay && (
        <PayModal
          total={totals.total}
          partyId={partyId}
          allowCredit={opt('allow_credit') === true}
          defaultMethod={String(opt('default_method')) as Tender['method']}
          onClose={() => setPay(false)}
          onPay={async (tenders) => {
            try {
              const r = await api<any>('pos.checkout', { partyId, lines: lines.map((l) => ({ productId: l.productId, description: l.name, unit: l.unit, qty: l.qty, rate: l.rate, discountPct: l.discountPct, taxRate: l.taxRate })), docDiscount, tenders: tenders.map((t) => ({ method: t.method, amount: t.amount })), holdId })
              setPay(false)
              setDone(r)
              clear()
              setTick((t) => t + 1)
              if (opt('auto_print') === true) printReceipt(r.id, true)
              return true
            } catch (e) {
              toast.error(e)
              return false
            }
          }}
        />
      )}
      {done && (
        <Modal open onClose={() => setDone(null)} title="Sale complete" size="sm" footer={<><Button icon={<Printer className="h-4 w-4" />} onClick={() => printReceipt(done.id)}>Print receipt</Button><Button variant="primary" onClick={() => (setDone(null), searchRef.current?.focus())}>New sale</Button></>}>
          <div className="space-y-2 text-center">
            <div className="text-[13px] text-muted">{done.number}</div>
            <div className="num text-[28px] font-extrabold">{money(done.total)}</div>
            {done.change > 0 && (
              <div className="rounded-xl bg-ok-soft p-3">
                <div className="text-[12.5px] font-semibold text-ok uppercase">Change to give back</div>
                <div className="num text-[30px] font-extrabold text-ok" data-testid="pos-change">{money(done.change)}</div>
              </div>
            )}
            {done.due > 0 && <div className="rounded-xl bg-warn-soft p-2 text-[13px] font-semibold text-warn">{money(done.due)} left on the customer's account</div>}
          </div>
        </Modal>
      )}
      {holdsOpen && <HeldModal onClose={() => setHoldsOpen(false)} onResume={(h) => { setLines(h.cart.lines); setPartyId(h.cart.partyId ?? null); setDocDiscount(h.cart.docDiscount ?? 0); setHoldId(h.id); setHoldsOpen(false) }} onChanged={() => setTick((t) => t + 1)} />}
      {recentOpen && <RecentModal onClose={() => setRecentOpen(false)} onPrint={printReceipt} onReturn={(id) => nav(`/doc/new/sale_return?from=${id}`)} />}
      {reportOpen && shift && <ReportModal id={shift.shift.id} onClose={() => setReportOpen(false)} />}
      {shiftsOpen && <ShiftsModal onClose={() => setShiftsOpen(false)} />}
      {moveOpen && <CashMoveModal onClose={() => setMoveOpen(false)} onDone={() => setTick((t) => t + 1)} />}
      {closeOpen && shift && <CloseShiftModal expected={shift.cash.expected} onClose={() => setCloseOpen(false)} onClosed={(id) => { setCloseOpen(false); setTick((t) => t + 1); api('print.open', { kind: 'posshift', id }).catch(() => undefined) }} />}
      <PartyForm open={newCust.open} type="customer" initialName={newCust.name} onClose={() => setNewCust({ open: false })} onSaved={async (id) => { await reloadParties(); setPartyId(id) }} />
    </div>
  )
}

function OpenShift({ can, onOpened }: { can: boolean; onOpened: () => void }): JSX.Element {
  const [cash, setCash] = useState(0)
  const [busy, setBusy] = useState(false)
  return (
    <Card>
      <div className="mx-auto max-w-sm space-y-3 py-6 text-center">
        <Clock className="mx-auto h-9 w-9 text-brand" />
        <div className="text-[18px] font-bold">Open your shift</div>
        <div className="text-[13px] text-muted">Count the cash in the drawer and enter it. Every sale from now on is part of this shift until you close it.</div>
        {can ? (
          <>
            <Field label="Cash in the drawer now"><NumberInput autoFocus value={cash} onChange={setCash} /></Field>
            <Button variant="primary" loading={busy} className="w-full" onClick={async () => { setBusy(true); try { await api('pos.openShift', { openingCash: cash }); onOpened() } catch (e) { toast.error(e) } finally { setBusy(false) } }} data-testid="pos-open-shift">
              Open shift
            </Button>
          </>
        ) : (
          <div className="text-[13px] font-medium text-warn">You do not have permission to open a shift. Ask the owner.</div>
        )}
      </div>
    </Card>
  )
}

function PayModal({ total, partyId, allowCredit, defaultMethod, onClose, onPay }: { total: number; partyId: number | null; allowCredit: boolean; defaultMethod: Tender['method']; onClose: () => void; onPay: (t: Tender[]) => Promise<boolean> }): JSX.Element {
  const [tenders, setTenders] = useState<Tender[]>([{ key: nextKey(), method: defaultMethod, amount: total }])
  const [busy, setBusy] = useState(false)
  const set = (key: string, patch: Partial<Tender>): void => setTenders((ts) => ts.map((t) => (t.key === key ? { ...t, ...patch } : t)))
  const nonCash = tenders.filter((t) => t.method !== 'cash').reduce((a, t) => a + (t.amount || 0), 0)
  const cashIn = tenders.filter((t) => t.method === 'cash').reduce((a, t) => a + (t.amount || 0), 0)
  const cashNeeded = Math.max(0, Math.round((total - nonCash) * 100) / 100)
  const change = Math.max(0, Math.round((cashIn - cashNeeded) * 100) / 100)
  const paid = Math.round((nonCash + Math.min(cashIn, cashNeeded)) * 100) / 100
  const due = Math.round((total - paid) * 100) / 100
  const tooMuch = nonCash > total + 0.005
  const creditOk = due <= 0.005 || (!!partyId && allowCredit)
  const canConfirm = !tooMuch && creditOk && !busy
  const firstCash = tenders.find((t) => t.method === 'cash')
  const setCashTo = (v: number): void => {
    if (firstCash) set(firstCash.key, { amount: v })
    else setTenders((ts) => [...ts, { key: nextKey(), method: 'cash', amount: v }])
  }
  return (
    <Modal
      open
      onClose={onClose}
      title="Take payment"
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Back</Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!canConfirm}
            data-testid="pos-confirm"
            onClick={async () => {
              setBusy(true)
              const ok = await onPay(tenders.filter((t) => t.amount > 0))
              if (!ok) setBusy(false)
            }}
          >
            Complete sale
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="rounded-xl bg-brand-soft p-3 text-center">
          <div className="text-[12.5px] font-semibold text-brand uppercase">Amount to pay</div>
          <div className="num text-[30px] font-extrabold text-brand">{money(total)}</div>
        </div>
        {tenders.map((t) => (
          <div key={t.key} className="flex items-center gap-2">
            <Select sm className="w-40" value={t.method} onChange={(e) => set(t.key, { method: e.target.value as Tender['method'] })} aria-label="Payment method">
              {Object.entries(METHOD_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </Select>
            <NumberInput className="flex-1" autoFocus={t.method === 'cash'} value={t.amount} onChange={(v) => set(t.key, { amount: v })} />
            {tenders.length > 1 && <button type="button" aria-label="Remove" className="text-muted hover:text-bad cursor-pointer" onClick={() => setTenders((ts) => ts.filter((x) => x.key !== t.key))}><X className="h-4 w-4" /></button>}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="sm" onClick={() => setCashTo(cashNeeded)}>Exact cash</Button>
          {[500, 1000, 5000, 10000].map((n) => <Button key={n} size="sm" onClick={() => setCashTo(n)}>{n}</Button>)}
          <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => setTenders((ts) => [...ts, { key: nextKey(), method: 'card', amount: 0 }])}>Another method</Button>
        </div>
        <div className="space-y-1 rounded-xl border border-line p-3 text-[14px]">
          <div className="flex justify-between"><span className="text-muted">Paid</span><span className="num font-semibold">{money(paid)}</span></div>
          {change > 0 && <div className="flex justify-between text-ok"><span className="font-semibold">Change to give back</span><span className="num text-[20px] font-extrabold" data-testid="pos-change-preview">{money(change)}</span></div>}
          {due > 0.005 && <div className={cx('flex justify-between', creditOk ? 'text-warn' : 'text-bad')}><span className="font-semibold">{creditOk ? 'Left on the customer account' : 'Still to pay'}</span><span className="num font-bold">{money(due)}</span></div>}
        </div>
        {tooMuch && <div className="text-[12.5px] font-medium text-bad">Card, bank and online amounts together are more than the bill.</div>}
        {!creditOk && due > 0.005 && <div className="text-[12.5px] font-medium text-bad">{partyId ? 'Credit sales are switched off. Take the full amount.' : 'A walk-in customer pays in full. Select a customer to leave a balance.'}</div>}
      </div>
    </Modal>
  )
}

function HeldModal({ onClose, onResume, onChanged }: { onClose: () => void; onResume: (h: any) => void; onChanged: () => void }): JSX.Element {
  const { data, reload } = useLoad(() => api<any[]>('pos.holds'), [])
  return (
    <Modal open onClose={onClose} title="Held bills" size="md" footer={<Button onClick={onClose}>Close</Button>}>
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty icon={<Pause />} title="No held bills">Hold a bill with F4 to serve another customer, then resume it here.</Empty>
      ) : (
        <div className="divide-y divide-line">
          {data.map((h) => (
            <div key={h.id} className="flex items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="font-semibold">{h.label || `Bill #${h.id}`}</div>
                <div className="text-[12.5px] text-muted">{h.cart.lines.length} item(s), {dateTime(h.created_at)}, by {h.cashier}</div>
              </div>
              <div className="num font-bold">{money(h.total)}</div>
              <Button size="sm" variant="primary" onClick={async () => { onResume(h); onChanged() }}>Resume</Button>
              <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={async () => { await api('pos.deleteHold', { id: h.id }); reload(); onChanged() }} />
            </div>
          ))}
        </div>
      )}
    </Modal>
  )
}

function RecentModal({ onClose, onPrint, onReturn }: { onClose: () => void; onPrint: (id: number) => void; onReturn: (id: number) => void }): JSX.Element {
  const { data } = useLoad(() => api<any[]>('pos.recent', { limit: 40 }), [])
  return (
    <Modal open onClose={onClose} title="Recent counter sales" size="lg" footer={<Button onClick={onClose}>Close</Button>}>
      {!data ? (
        <Loading />
      ) : data.length === 0 ? (
        <Empty icon={<Receipt />} title="No counter sales yet" />
      ) : (
        <table className="tbl">
          <thead><tr><th>Receipt</th><th>Time</th><th>Customer</th><th>Cashier</th><th className="text-right">Total</th><th className="text-right">Change</th><th /></tr></thead>
          <tbody>
            {data.map((r) => (
              <tr key={r.id}>
                <td className="font-medium">{r.number} {r.status === 'cancelled' && <Badge tone="bad">Cancelled</Badge>}</td>
                <td>{dateTime(r.created_at)}</td>
                <td>{r.party_name}</td>
                <td>{r.cashier}</td>
                <td className="num text-right font-semibold">{money(r.grand_total)}</td>
                <td className="num text-right">{r.change_given > 0 ? money(r.change_given) : '-'}</td>
                <td className="whitespace-nowrap text-right">
                  <Button size="sm" variant="ghost" icon={<Printer className="h-4 w-4" />} onClick={() => onPrint(r.id)}>Reprint</Button>
                  {r.status !== 'cancelled' && <Button size="sm" variant="ghost" icon={<Undo2 className="h-4 w-4" />} onClick={() => onReturn(r.id)}>Return</Button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Modal>
  )
}

export function ShiftSummary({ sum }: { sum: any }): JSX.Element {
  const s = sum.shift
  return (
    <div className="space-y-3 text-[13.5px]">
      <div className="grid grid-cols-2 gap-2 text-[13px]">
        <div><span className="text-muted">Cashier</span><div className="font-semibold">{sum.cashier}</div></div>
        <div><span className="text-muted">Opened</span><div className="font-semibold">{dateTime(s.opened_at)}</div></div>
        <div><span className="text-muted">Status</span><div className="font-semibold">{s.status === 'open' ? 'Open' : `Closed ${dateTime(s.closed_at)}`}</div></div>
        <div><span className="text-muted">Items sold</span><div className="font-semibold">{fmtQty(sum.sales.items)}</div></div>
      </div>
      <table className="tbl">
        <tbody>
          <tr><td>Sales ({sum.sales.count})</td><td className="num text-right font-semibold">{money(sum.sales.total)}</td></tr>
          {sum.sales.discount > 0 && <tr><td>Discounts given</td><td className="num text-right">{money(sum.sales.discount)}</td></tr>}
          {sum.cancelled.count > 0 && <tr><td>Cancelled bills ({sum.cancelled.count})</td><td className="num text-right text-bad">{money(sum.cancelled.total)}</td></tr>}
          {sum.byMethod.map((m: any) => <tr key={m.method}><td className="pl-6 text-muted">Received by {METHOD_LABEL[m.method] ?? m.method}</td><td className="num text-right">{money(m.amount)}</td></tr>)}
          {sum.credit > 0 && <tr><td className="pl-6 text-muted">Left on customer accounts</td><td className="num text-right">{money(sum.credit)}</td></tr>}
        </tbody>
      </table>
      <table className="tbl">
        <tbody>
          <tr><td>Cash in the drawer at the start</td><td className="num text-right">{money(sum.cash.opening)}</td></tr>
          <tr><td>Cash from sales</td><td className="num text-right">{money(sum.cash.sales)}</td></tr>
          <tr><td>Cash put in</td><td className="num text-right">{money(sum.cash.in)}</td></tr>
          <tr><td>Cash taken out</td><td className="num text-right">- {money(sum.cash.out)}</td></tr>
          <tr><td className="font-bold">Drawer should hold</td><td className="num text-right font-bold">{money(sum.cash.expected)}</td></tr>
          {s.status === 'closed' && <tr><td>Counted</td><td className="num text-right">{money(s.counted_cash)}</td></tr>}
          {s.status === 'closed' && <tr><td className="font-bold">Difference</td><td className={cx('num text-right font-bold', s.difference < 0 ? 'text-bad' : s.difference > 0 ? 'text-warn' : 'text-ok')}>{money(s.difference)}</td></tr>}
        </tbody>
      </table>
      {sum.moves.length > 0 && (
        <div className="text-[12.5px] text-muted">
          {sum.moves.map((m: any, i: number) => <div key={i}>{m.kind === 'in' ? 'Cash in' : 'Cash out'} {money(m.amount)}, {m.reason ?? ''}</div>)}
        </div>
      )}
    </div>
  )
}

function ReportModal({ id, onClose }: { id: number; onClose: () => void }): JSX.Element {
  const { data } = useLoad(() => api<any>('pos.shiftReport', { id }), [id])
  return (
    <Modal open onClose={onClose} title="Shift report" size="sm" footer={<><Button icon={<Printer className="h-4 w-4" />} onClick={() => api('print.open', { kind: 'posshift', id }).catch(toast.error)}>Print</Button><Button onClick={onClose}>Close</Button></>}>
      {data ? <ShiftSummary sum={data} /> : <Loading />}
    </Modal>
  )
}

function ShiftsModal({ onClose }: { onClose: () => void }): JSX.Element {
  const { data } = useLoad(() => api<any[]>('pos.shifts', { limit: 60 }), [])
  const [view, setView] = useState<number | null>(null)
  return (
    <>
      <Modal open onClose={onClose} title="Shifts" size="lg" footer={<Button onClick={onClose}>Close</Button>}>
        {!data ? (
          <Loading />
        ) : data.length === 0 ? (
          <Empty icon={<Clock />} title="No shifts yet" />
        ) : (
          <table className="tbl">
            <thead><tr><th>Cashier</th><th>Opened</th><th>Closed</th><th className="text-right">Sales</th><th className="text-right">Expected</th><th className="text-right">Counted</th><th className="text-right">Difference</th><th /></tr></thead>
            <tbody>
              {data.map((s) => (
                <tr key={s.id}>
                  <td>{s.cashier}</td>
                  <td>{dateTime(s.opened_at)}</td>
                  <td>{s.status === 'open' ? <Badge tone="ok">Open</Badge> : dateTime(s.closed_at)}</td>
                  <td className="num text-right">{s.sales_count} / {money(s.sales_total)}</td>
                  <td className="num text-right">{s.expected_cash === null ? '-' : money(s.expected_cash)}</td>
                  <td className="num text-right">{s.counted_cash === null ? '-' : money(s.counted_cash)}</td>
                  <td className={cx('num text-right font-semibold', (s.difference ?? 0) < 0 ? 'text-bad' : (s.difference ?? 0) > 0 ? 'text-warn' : '')}>{s.difference === null ? '-' : money(s.difference)}</td>
                  <td className="text-right"><Button size="sm" variant="ghost" onClick={() => setView(s.id)}>View</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Modal>
      {view && <ReportModal id={view} onClose={() => setView(null)} />}
    </>
  )
}

function CashMoveModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }): JSX.Element {
  const [kind, setKind] = useState<'in' | 'out'>('out')
  const [amount, setAmount] = useState(0)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal open onClose={onClose} title="Cash in / out of the drawer" size="sm" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { await api('pos.cashMove', { kind, amount, reason }); toast.ok('Saved.'); onDone(); onClose() } catch (e) { toast.error(e) } finally { setBusy(false) } }}>Save</Button></>}>
      <div className="space-y-3">
        <Select value={kind} onChange={(e) => setKind(e.target.value as 'in' | 'out')} aria-label="Cash in or out">
          <option value="out">Cash taken out (expense, refund, deposit)</option>
          <option value="in">Cash put in (float, top-up)</option>
        </Select>
        <Field label="Amount"><NumberInput autoFocus value={amount} onChange={setAmount} /></Field>
        <Field label={kind === 'out' ? 'What is it for' : 'Note (optional)'}><Input value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  )
}

function CloseShiftModal({ expected, onClose, onClosed }: { expected: number; onClose: () => void; onClosed: (shiftId: number) => void }): JSX.Element {
  const [counted, setCounted] = useState<number | null>(null)
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const diff = counted === null ? null : Math.round((counted - expected) * 100) / 100
  return (
    <Modal
      open
      onClose={onClose}
      title="Close the shift"
      size="sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            loading={busy}
            disabled={counted === null}
            data-testid="pos-close-confirm"
            onClick={async () => {
              setBusy(true)
              try {
                const r = await api<any>('pos.closeShift', { countedCash: counted, notes })
                toast.ok('Shift closed.')
                onClosed(r.shift.id)
              } catch (e) {
                toast.error(e)
                setBusy(false)
              }
            }}
          >
            Close shift
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="rounded-xl bg-surface-2 p-3 text-center">
          <div className="text-[12.5px] text-muted">The drawer should hold</div>
          <div className="num text-[24px] font-extrabold">{money(expected)}</div>
        </div>
        <Field label="Cash you counted"><NumberInput autoFocus value={counted} onChange={setCounted} /></Field>
        {diff !== null && <div className={cx('text-[13px] font-semibold', diff < 0 ? 'text-bad' : diff > 0 ? 'text-warn' : 'text-ok')}>{diff === 0 ? 'The drawer matches.' : diff < 0 ? `Short by ${money(-diff)}` : `Over by ${money(diff)}`}</div>}
        <Field label="Note (optional)"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
      </div>
    </Modal>
  )
}

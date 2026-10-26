/**
 * Reorder planning: goods at or below their low-stock level, with a suggested quantity, the supplier and price of the last
 * purchase, and one step to make the purchase orders. The module is switched on in Settings, Simple / Customize.
 */
import { num, round2 } from '../../shared/money'
import { AppError, Ctx, audit, optId, requirePerm, today, visibleTo } from './context'
import { assertModule } from './moduleGate'
import { createDocument } from './documents'

export interface Suggestion {
  product_id: number
  name: string
  sku: string | null
  unit: string
  stock: number
  reorder_level: number
  on_order: number
  suggested_qty: number
  supplier_id: number | null
  supplier_name: string | null
  last_rate: number | null
  last_date: string | null
}

export function suggestions(ctx: Ctx, f: { cover?: number } = {}): Suggestion[] {
  assertModule(ctx, 'reorder')
  requirePerm(ctx, 'inventory.view')
  const cover = Math.min(10, Math.max(1, num(f.cover, 2)))
  const rows = ctx.db
    .prepare(
      `SELECT p.id AS product_id, p.name, p.sku, p.unit, p.reorder_level,
         COALESCE((SELECT SUM(sl.qty) FROM stock_levels sl JOIN warehouses w ON w.id = sl.warehouse_id WHERE sl.product_id = p.id AND (w.firm_id IS NULL OR w.firm_id = @firmId)), 0) AS stock,
         COALESCE((SELECT SUM(l.qty) FROM document_lines l JOIN documents d ON d.id = l.document_id
                    WHERE l.product_id = p.id AND d.firm_id = @firmId AND d.doc_type = 'purchase_order' AND d.status NOT IN ('cancelled','converted')), 0) AS on_order
       FROM products p WHERE p.type = 'goods' AND p.is_active = 1 AND p.reorder_level > 0 AND ${visibleTo('p')} ORDER BY p.name`
    )
    .all({ firmId: ctx.firmId }) as Array<Omit<Suggestion, 'suggested_qty' | 'supplier_id' | 'supplier_name' | 'last_rate' | 'last_date'>>
  const last = ctx.db.prepare(
    `SELECT d.party_id AS supplier_id, pa.name AS supplier_name, l.rate AS last_rate, d.date AS last_date
       FROM document_lines l JOIN documents d ON d.id = l.document_id LEFT JOIN parties pa ON pa.id = d.party_id
      WHERE l.product_id = ? AND d.firm_id = ? AND d.doc_type = 'purchase_invoice' AND d.status <> 'cancelled' ORDER BY d.date DESC, d.id DESC LIMIT 1`
  )
  const out: Suggestion[] = []
  for (const r of rows) {
    if (r.stock > r.reorder_level) continue
    const want = Math.ceil(r.reorder_level * cover - r.stock - r.on_order)
    if (want <= 0) continue
    const l = last.get(r.product_id, ctx.firmId) as { supplier_id: number | null; supplier_name: string | null; last_rate: number; last_date: string } | undefined
    out.push({ ...r, stock: round2(r.stock), on_order: round2(r.on_order), suggested_qty: want, supplier_id: l?.supplier_id ?? null, supplier_name: l?.supplier_name ?? null, last_rate: l?.last_rate ?? null, last_date: l?.last_date ?? null })
  }
  return out
}

/** One purchase order per supplier from the chosen lines. Lines without a supplier are refused so nothing is silently dropped. */
export function createOrders(ctx: Ctx, input: { items: Array<{ productId: number; qty: number; rate?: number; supplierId?: number | null }> }): Array<{ id: number; number: string; supplier: string; lines: number }> {
  assertModule(ctx, 'reorder')
  requirePerm(ctx, 'purchases.create')
  const items = (input.items ?? []).filter((i) => num(i.qty) > 0)
  if (!items.length) throw new AppError('Choose at least one item to order.', 'VALIDATION')
  const missing = items.filter((i) => !optId(i.supplierId))
  if (missing.length) throw new AppError(`Choose a supplier for ${missing.length} item(s) first.`, 'VALIDATION')
  const bySupplier = new Map<number, typeof items>()
  for (const i of items) bySupplier.set(Number(i.supplierId), [...(bySupplier.get(Number(i.supplierId)) ?? []), i])
  return ctx.db.transaction(() => {
    const made: Array<{ id: number; number: string; supplier: string; lines: number }> = []
    for (const [supplierId, lines] of bySupplier) {
      const id = createDocument(ctx, {
        docType: 'purchase_order',
        date: today(),
        partyId: supplierId,
        notes: 'Made from Reorder Planning',
        lines: lines.map((l) => {
          const p = ctx.db.prepare('SELECT name, unit, purchase_price FROM products WHERE id = ?').get(l.productId) as { name: string; unit: string; purchase_price: number | null } | undefined
          if (!p) throw new AppError('An item was not found.', 'NOT_FOUND')
          return { productId: l.productId, description: p.name, unit: p.unit, qty: num(l.qty), rate: l.rate !== undefined ? num(l.rate) : (p.purchase_price ?? 0) }
        })
      })
      const doc = ctx.db.prepare('SELECT d.number, pa.name AS supplier FROM documents d LEFT JOIN parties pa ON pa.id = d.party_id WHERE d.id = ?').get(id) as { number: string; supplier: string }
      made.push({ id, number: doc.number, supplier: doc.supplier, lines: lines.length })
    }
    audit(ctx, 'create', 'purchase_order', null, `Made ${made.length} purchase order(s) from Reorder Planning`)
    return made
  })()
}

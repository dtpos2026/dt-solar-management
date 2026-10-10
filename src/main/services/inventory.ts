/**
 * Inventory engine.
 *
 * Valuation method: MOVING WEIGHTED AVERAGE COST (per product, across all warehouses).
 *  - Stock IN at cost c:   newAvg = (Q * avg + q * c) / (Q + q)    (if Q <= 0 then newAvg = c)
 *  - Stock OUT (sale/issue): leaves at the current average cost; average does not change.
 *  - Stock OUT that removes a specific cost (purchase return / reversal of a receipt):
 *        newAvg = (Q * avg - q * c) / (Q - q)   (kept unchanged if the remaining qty is 0 or the result is negative)
 *  - Every movement stores the unit cost used, so COGS / project material cost are traceable.
 *  - Cancelling or editing a document posts exact reversal movements (never deletes history).
 */
import type { DB } from '../db'
import { EPS, num, round2, round3, round4 } from '../../shared/money'
import {
  AppError,
  Ctx,
  audit,
  can,
  getSetting,
  like,
  optId,
  optText,
  requireDate,
  requirePerm,
  requireText,
  visibleTo
} from './context'
import { nextNumber } from './firms'

interface ProductRow {
  id: number
  firm_id: number | null
  name: string
  type: 'goods' | 'service'
  unit: string
  avg_cost: number
  track_serial: number
  sale_price: number
  purchase_price: number
  tax_rate: number
  warranty_months: number
  warranty_terms: string | null
  is_active: number
}

export interface MoveInput {
  firmId: number
  productId: number
  warehouseId: number
  qty: number
  unitCost?: number
  date: string
  refType: string
  refId?: number | null
  refLineId?: number | null
  refNumber?: string | null
  projectId?: number | null
  batchNo?: string | null
  notes?: string | null
  userId?: number | null
}

export function getProductRow(db: DB, id: number): ProductRow {
  const p = db.prepare('SELECT * FROM products WHERE id = ?').get(id) as ProductRow | undefined
  if (!p) throw new AppError('Product not found.', 'NOT_FOUND')
  return p
}

export function totalQty(db: DB, productId: number): number {
  const r = db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM stock_levels WHERE product_id = ?').get(productId) as { q: number }
  return round3(r.q)
}

export function warehouseQty(db: DB, productId: number, warehouseId: number): number {
  const r = db.prepare('SELECT qty FROM stock_levels WHERE product_id = ? AND warehouse_id = ?').get(productId, warehouseId) as
    | { qty: number }
    | undefined
  return round3(r?.qty ?? 0)
}

function bumpLevel(db: DB, productId: number, warehouseId: number, delta: number): void {
  db.prepare(
    `INSERT INTO stock_levels (product_id, warehouse_id, qty) VALUES (?, ?, ?)
     ON CONFLICT(product_id, warehouse_id) DO UPDATE SET qty = round(qty + excluded.qty, 3)`
  ).run(productId, warehouseId, round3(delta))
}

function insertMovement(
  db: DB,
  m: MoveInput,
  qtyIn: number,
  qtyOut: number,
  unitCost: number,
  avgAfter: number,
  isReversal = false
): void {
  db.prepare(
    `INSERT INTO stock_movements (date, firm_id, product_id, warehouse_id, qty_in, qty_out, unit_cost, avg_cost_after,
       ref_type, ref_id, ref_line_id, ref_number, project_id, batch_no, is_reversal, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    m.date,
    m.firmId,
    m.productId,
    m.warehouseId,
    round3(qtyIn),
    round3(qtyOut),
    round4(unitCost),
    round4(avgAfter),
    m.refType,
    m.refId ?? null,
    m.refLineId ?? null,
    m.refNumber ?? null,
    m.projectId ?? null,
    m.batchNo ?? null,
    isReversal ? 1 : 0,
    m.notes ?? null,
    m.userId ?? null
  )
}

function assertWarehouse(db: DB, warehouseId: number): { name: string } {
  const w = db.prepare('SELECT name FROM warehouses WHERE id = ?').get(warehouseId) as { name: string } | undefined
  if (!w) throw new AppError('Warehouse not found.', 'VALIDATION')
  return w
}

/** Receive stock at a cost (weighted average). Services are ignored. */
export function stockIn(db: DB, m: MoveInput, isReversal = false): number {
  const p = getProductRow(db, m.productId)
  if (p.type === 'service') return 0
  assertWarehouse(db, m.warehouseId)
  const qty = round3(m.qty)
  if (qty <= 0) throw new AppError(`Quantity must be greater than zero for ${p.name}.`, 'VALIDATION')
  const cost = round4(Math.max(0, m.unitCost ?? p.avg_cost))
  const Q = totalQty(db, p.id)
  const newAvg = Q <= EPS ? cost : (Q * p.avg_cost + qty * cost) / (Q + qty)
  db.prepare("UPDATE products SET avg_cost = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(round4(newAvg), p.id)
  bumpLevel(db, p.id, m.warehouseId, qty)
  insertMovement(db, m, qty, 0, cost, newAvg, isReversal)
  return cost
}

/**
 * Take stock out. Returns the unit cost used.
 * removeCost: remove a specific cost (purchase return / receipt reversal) and re-average the remaining stock.
 */
export function stockOut(
  db: DB,
  m: MoveInput,
  opts: { allowNegative?: boolean; removeCost?: boolean; isReversal?: boolean } = {}
): number {
  const p = getProductRow(db, m.productId)
  if (p.type === 'service') return 0
  const wh = assertWarehouse(db, m.warehouseId)
  const qty = round3(m.qty)
  if (qty <= 0) throw new AppError(`Quantity must be greater than zero for ${p.name}.`, 'VALIDATION')
  const available = warehouseQty(db, p.id, m.warehouseId)
  const allowNegative = opts.allowNegative ?? getSetting(db, 'allow_negative_stock', false)
  if (!allowNegative && available + EPS < qty) {
    throw new AppError(
      `Insufficient stock for "${p.name}" in ${wh.name}. Available: ${available} ${p.unit}, required: ${qty} ${p.unit}.`,
      'STOCK'
    )
  }
  let cost = round4(p.avg_cost)
  let newAvg = p.avg_cost
  if (opts.removeCost && m.unitCost !== undefined) {
    cost = round4(Math.max(0, m.unitCost))
    const Q = totalQty(db, p.id)
    const remaining = Q - qty
    if (remaining > EPS) {
      const candidate = (Q * p.avg_cost - qty * cost) / remaining
      newAvg = candidate >= 0 ? candidate : p.avg_cost
    }
    db.prepare("UPDATE products SET avg_cost = ?, updated_at = datetime('now','localtime') WHERE id = ?").run(round4(newAvg), p.id)
  }
  bumpLevel(db, p.id, m.warehouseId, -qty)
  insertMovement(db, m, 0, qty, cost, newAvg, opts.isReversal)
  return cost
}

/** Post exact reversals for all live movements of a reference (used by cancel / edit). */
export function reverseMovements(db: DB, refType: string, refId: number, userId: number | null, date: string): void {
  const rows = db
    .prepare(
      'SELECT * FROM stock_movements WHERE ref_type = ? AND ref_id = ? AND is_reversal = 0 AND reversed = 0 ORDER BY id DESC'
    )
    .all(refType, refId) as Array<{
    id: number
    firm_id: number
    product_id: number
    warehouse_id: number
    qty_in: number
    qty_out: number
    unit_cost: number
    ref_line_id: number | null
    ref_number: string | null
    project_id: number | null
    batch_no: string | null
  }>
  for (const r of rows) {
    const m: MoveInput = {
      firmId: r.firm_id,
      productId: r.product_id,
      warehouseId: r.warehouse_id,
      qty: r.qty_in > 0 ? r.qty_in : r.qty_out,
      unitCost: r.unit_cost,
      date,
      refType,
      refId,
      refLineId: r.ref_line_id,
      refNumber: r.ref_number,
      projectId: r.project_id,
      batchNo: r.batch_no,
      notes: 'Reversal',
      userId
    }
    if (r.qty_in > 0) {
      try {
        stockOut(db, m, { removeCost: true, isReversal: true })
      } catch (e) {
        if (e instanceof AppError && e.code === 'STOCK') {
          throw new AppError(
            `Cannot reverse this transaction: ${e.message} Some of the received stock has already been sold or issued.`,
            'STOCK'
          )
        }
        throw e
      }
    } else {
      stockIn(db, m, true)
    }
    db.prepare('UPDATE stock_movements SET reversed = 1 WHERE id = ?').run(r.id)
  }
}

/* ------------------------------ Serials ------------------------------ */

export function parseSerials(s: unknown): string[] {
  if (!s) return []
  const list = String(s)
    .split(/[\n,;]+/)
    .map((x) => x.trim())
    .filter(Boolean)
  return Array.from(new Set(list))
}

export function checkSerialCount(p: { name: string; track_serial: number; type: string }, qty: number, serials: string[]): void {
  if (!p.track_serial || p.type === 'service') return
  if (!Number.isInteger(qty)) throw new AppError(`"${p.name}" is serial-tracked; quantity must be a whole number.`, 'VALIDATION')
  if (serials.length !== qty) {
    throw new AppError(`"${p.name}" is serial-tracked: enter exactly ${qty} serial number(s) (entered ${serials.length}).`, 'VALIDATION')
  }
}

export function serialsIn(
  db: DB,
  productId: number,
  serials: string[],
  o: { warehouseId: number; refType: string; refId: number; isReturn?: boolean }
): void {
  for (const s of serials) {
    const row = db.prepare('SELECT * FROM serials WHERE product_id = ? AND serial = ?').get(productId, s) as
      | { id: number; status: string }
      | undefined
    if (row) {
      if (row.status === 'in_stock') throw new AppError(`Serial number ${s} is already in stock.`, 'VALIDATION')
      db.prepare(
        `UPDATE serials SET status = 'in_stock', warehouse_id = ?, in_ref_type = ?, in_ref_id = ? WHERE id = ?`
      ).run(o.warehouseId, o.refType, o.refId, row.id)
    } else {
      db.prepare(
        `INSERT INTO serials (product_id, serial, status, warehouse_id, in_ref_type, in_ref_id) VALUES (?, ?, 'in_stock', ?, ?, ?)`
      ).run(productId, s, o.warehouseId, o.refType, o.refId)
    }
  }
}

export function serialsOut(
  db: DB,
  productId: number,
  serials: string[],
  o: { refType: string; refId: number; status: 'sold' | 'issued' | 'returned'; partyId?: number | null; projectId?: number | null; date: string; strict: boolean }
): void {
  for (const s of serials) {
    const row = db.prepare('SELECT * FROM serials WHERE product_id = ? AND serial = ?').get(productId, s) as
      | { id: number; status: string }
      | undefined
    if (!row) {
      if (o.strict) throw new AppError(`Serial number ${s} is not in stock.`, 'VALIDATION')
      db.prepare(
        `INSERT INTO serials (product_id, serial, status, out_ref_type, out_ref_id, party_id, project_id, out_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(productId, s, o.status, o.refType, o.refId, o.partyId ?? null, o.projectId ?? null, o.date)
      continue
    }
    if (row.status !== 'in_stock' && o.strict) throw new AppError(`Serial number ${s} is not in stock (${row.status}).`, 'VALIDATION')
    db.prepare(
      `UPDATE serials SET status = ?, out_ref_type = ?, out_ref_id = ?, party_id = ?, project_id = ?, out_date = ? WHERE id = ?`
    ).run(o.status, o.refType, o.refId, o.partyId ?? null, o.projectId ?? null, o.date, row.id)
  }
}

/** Undo serial changes made by a reference. */
export function reverseSerials(db: DB, refType: string, refId: number): void {
  // Serials that left stock because of this reference go back into stock.
  db.prepare(
    `UPDATE serials SET status = 'in_stock', out_ref_type = NULL, out_ref_id = NULL, party_id = NULL, project_id = NULL, out_date = NULL
     WHERE out_ref_type = ? AND out_ref_id = ?`
  ).run(refType, refId)
  const ins = db.prepare('SELECT * FROM serials WHERE in_ref_type = ? AND in_ref_id = ?').all(refType, refId) as Array<{
    id: number
    serial: string
    status: string
    out_ref_type: string | null
  }>
  for (const r of ins) {
    if (r.status !== 'in_stock') {
      throw new AppError(`Serial number ${r.serial} has already been sold/issued; reverse that transaction first.`, 'VALIDATION')
    }
    if (r.out_ref_type) {
      // It was returned into stock: restore the previous "out" state.
      const prev = r.out_ref_type === 'material_issue' ? 'issued' : r.out_ref_type === 'purchase_return' ? 'returned' : 'sold'
      db.prepare('UPDATE serials SET status = ?, in_ref_type = NULL, in_ref_id = NULL WHERE id = ?').run(prev, r.id)
    } else {
      db.prepare('DELETE FROM serials WHERE id = ?').run(r.id)
    }
  }
}

/* ------------------------------ Products ------------------------------ */

export interface ProductInput {
  id?: number
  name: string
  categoryId?: number | null
  sku?: string
  barcode?: string
  type?: 'goods' | 'service'
  unit?: string
  brand?: string
  model?: string
  description?: string
  purchasePrice?: number
  salePrice?: number
  minSalePrice?: number
  taxRate?: number
  reorderLevel?: number
  trackSerial?: boolean
  warrantyMonths?: number
  warrantyTerms?: string
  isActive?: boolean
  openingQty?: number
  openingCost?: number
  openingWarehouseId?: number
  openingSerials?: string
}

export function listProducts(
  ctx: Ctx,
  f: { q?: string; categoryId?: number; type?: string; active?: 'all' | 'active' | 'inactive'; stock?: 'low' | 'out' | 'in'; limit?: number; offset?: number } = {}
): { rows: unknown[]; total: number } {
  const where = [visibleTo('p')]
  const p: Record<string, unknown> = { firmId: ctx.firmId }
  if (f.q) {
    where.push("(p.name LIKE @q ESCAPE '\\' OR p.sku LIKE @q ESCAPE '\\' OR p.barcode LIKE @q ESCAPE '\\' OR p.brand LIKE @q ESCAPE '\\' OR p.model LIKE @q ESCAPE '\\')")
    p.q = like(f.q)
  }
  if (f.categoryId) {
    where.push('p.category_id = @cat')
    p.cat = f.categoryId
  }
  if (f.type) {
    where.push('p.type = @type')
    p.type = f.type
  }
  if (f.active !== 'all') where.push(f.active === 'inactive' ? 'p.is_active = 0' : 'p.is_active = 1')
  const stockExpr = `COALESCE((SELECT SUM(sl.qty) FROM stock_levels sl JOIN warehouses w ON w.id = sl.warehouse_id
      WHERE sl.product_id = p.id AND (w.firm_id IS NULL OR w.firm_id = @firmId)), 0)`
  if (f.stock === 'low') where.push(`p.type = 'goods' AND ${stockExpr} > 0 AND ${stockExpr} <= p.reorder_level`)
  if (f.stock === 'out') where.push(`p.type = 'goods' AND ${stockExpr} <= 0`)
  if (f.stock === 'in') where.push(`p.type = 'goods' AND ${stockExpr} > 0`)
  const w = where.join(' AND ')
  const total = (ctx.db.prepare(`SELECT COUNT(*) AS c FROM products p WHERE ${w}`).get(p) as { c: number }).c
  const showCost = can(ctx, 'inventory.cost')
  const rows = ctx.db
    .prepare(
      `SELECT p.id, p.firm_id, p.name, p.sku, p.barcode, p.type, p.unit, p.brand, p.model, p.sale_price, p.min_sale_price,
         p.tax_rate, p.reorder_level, p.track_serial, p.warranty_months, p.warranty_terms, p.is_active, p.category_id,
         c.name AS category_name,
         ${showCost ? 'p.purchase_price, p.avg_cost,' : 'NULL AS purchase_price, NULL AS avg_cost,'}
         ${stockExpr} AS stock
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE ${w} ORDER BY p.name LIMIT @limit OFFSET @offset`
    )
    .all({ ...p, limit: Math.min(f.limit ?? 500, 5000), offset: f.offset ?? 0 }) as Array<Record<string, number>>
  for (const r of rows) {
    r.stock = round3(r.stock)
    if (showCost) r.stock_value = round2(Math.max(0, r.stock) * (r.avg_cost || 0))
  }
  return { rows, total }
}

export function getProduct(ctx: Ctx, id: number): unknown {
  const p = ctx.db
    .prepare(`SELECT p.*, c.name AS category_name FROM products p LEFT JOIN categories c ON c.id = p.category_id WHERE p.id = @id AND ${visibleTo('p')}`)
    .get({ id, firmId: ctx.firmId }) as Record<string, unknown> | undefined
  if (!p) throw new AppError('Product not found.', 'NOT_FOUND')
  if (!can(ctx, 'inventory.cost')) {
    p.purchase_price = null
    p.avg_cost = null
  }
  const stock = ctx.db
    .prepare(
      `SELECT w.id AS warehouse_id, w.name AS warehouse_name, COALESCE(sl.qty, 0) AS qty
       FROM warehouses w LEFT JOIN stock_levels sl ON sl.warehouse_id = w.id AND sl.product_id = @id
       WHERE (w.firm_id IS NULL OR w.firm_id = @firmId) AND w.is_active = 1 ORDER BY w.is_default DESC, w.name`
    )
    .all({ id, firmId: ctx.firmId })
  const serials = ctx.db
    .prepare("SELECT serial, warehouse_id FROM serials WHERE product_id = ? AND status = 'in_stock' ORDER BY serial LIMIT 2000")
    .all(id)
  return { ...p, stock_by_warehouse: stock, serials_in_stock: serials }
}

export function saveProduct(ctx: Ctx, input: ProductInput): number {
  requirePerm(ctx, 'inventory.manage')
  const db = ctx.db
  const name = requireText(input.name, 'Product name', 200)
  const type = input.type === 'service' ? 'service' : 'goods'
  const sku = optText(input.sku, 60)
  if (sku) {
    const dup = db.prepare('SELECT id FROM products WHERE sku = ? AND id <> ?').get(sku, input.id ?? 0)
    if (dup) throw new AppError(`SKU "${sku}" is already used by another product.`, 'VALIDATION')
  }
  const salePrice = round2(num(input.salePrice))
  const purchasePrice = round2(num(input.purchasePrice))
  if (salePrice < 0 || purchasePrice < 0) throw new AppError('Prices cannot be negative.', 'VALIDATION')
  const taxRate = round2(num(input.taxRate))
  if (taxRate < 0 || taxRate > 100) throw new AppError('Tax rate must be between 0 and 100.', 'VALIDATION')
  const vals = {
    name,
    category_id: optId(input.categoryId),
    sku,
    barcode: optText(input.barcode, 60),
    type,
    unit: optText(input.unit, 20) ?? (type === 'service' ? 'job' : 'pcs'),
    brand: optText(input.brand, 80),
    model: optText(input.model, 80),
    description: optText(input.description, 2000),
    purchase_price: purchasePrice,
    sale_price: salePrice,
    min_sale_price: round2(num(input.minSalePrice)),
    tax_rate: taxRate,
    reorder_level: round3(num(input.reorderLevel)),
    track_serial: input.trackSerial && type === 'goods' ? 1 : 0,
    warranty_months: Math.max(0, Math.floor(num(input.warrantyMonths))),
    warranty_terms: optText(input.warrantyTerms, 500),
    is_active: input.isActive === false ? 0 : 1
  }
  return db.transaction(() => {
    if (input.id) {
      const existing = db
        .prepare(`SELECT * FROM products p WHERE id = @id AND ${visibleTo('p')}`)
        .get({ id: input.id, firmId: ctx.firmId }) as ProductRow | undefined
      if (!existing) throw new AppError('Product not found.', 'NOT_FOUND')
      if (existing.type !== type) {
        const used = db.prepare('SELECT 1 FROM stock_movements WHERE product_id = ? LIMIT 1').get(input.id)
        if (used) throw new AppError('Product type cannot be changed after stock transactions exist.', 'VALIDATION')
      }
      db.prepare(
        `UPDATE products SET name=@name, category_id=@category_id, sku=@sku, barcode=@barcode, type=@type, unit=@unit, brand=@brand,
           model=@model, description=@description, purchase_price=@purchase_price, sale_price=@sale_price,
           min_sale_price=@min_sale_price, tax_rate=@tax_rate, reorder_level=@reorder_level, track_serial=@track_serial,
           warranty_months=@warranty_months, warranty_terms=@warranty_terms, is_active=@is_active,
           updated_at=datetime('now','localtime') WHERE id=@id`
      ).run({ ...vals, id: input.id })
      audit(ctx, 'update', 'product', input.id, `Updated product ${name}`)
      return input.id
    }
    const shared = getSetting(db, 'share_inventory', true)
    const id = Number(
      db
        .prepare(
          `INSERT INTO products (firm_id, name, category_id, sku, barcode, type, unit, brand, model, description, purchase_price,
             sale_price, min_sale_price, tax_rate, reorder_level, track_serial, warranty_months, warranty_terms, is_active, avg_cost, created_by)
           VALUES (@firm_id, @name, @category_id, @sku, @barcode, @type, @unit, @brand, @model, @description, @purchase_price,
             @sale_price, @min_sale_price, @tax_rate, @reorder_level, @track_serial, @warranty_months, @warranty_terms, @is_active,
             @purchase_price, @created_by)`
        )
        .run({ ...vals, firm_id: shared ? null : ctx.firmId, created_by: ctx.user.id }).lastInsertRowid
    )
    audit(ctx, 'create', 'product', id, `Created product ${name}`)
    const openingQty = round3(num(input.openingQty))
    if (openingQty > 0 && type === 'goods') {
      requirePerm(ctx, 'inventory.adjust')
      const wh = optId(input.openingWarehouseId) ?? defaultWarehouseId(ctx)
      createAdjustment(ctx, {
        date: new Date().toISOString().slice(0, 10),
        warehouseId: wh,
        kind: 'opening',
        reason: 'Opening stock',
        lines: [{ productId: id, qty: openingQty, unitCost: num(input.openingCost, purchasePrice), serials: input.openingSerials }]
      })
    }
    return id
  })()
}

export function deleteProduct(ctx: Ctx, id: number): { deleted: boolean } {
  requirePerm(ctx, 'inventory.manage')
  const db = ctx.db
  const p = getProductRow(db, id)
  const used =
    db.prepare('SELECT 1 FROM stock_movements WHERE product_id = ? LIMIT 1').get(id) ||
    db.prepare('SELECT 1 FROM document_lines WHERE product_id = ? LIMIT 1').get(id) ||
    db.prepare('SELECT 1 FROM material_move_lines WHERE product_id = ? LIMIT 1').get(id)
  if (used) {
    db.prepare('UPDATE products SET is_active = 0 WHERE id = ?').run(id)
    audit(ctx, 'deactivate', 'product', id, `Deactivated product ${p.name} (has transactions)`)
    return { deleted: false }
  }
  db.transaction(() => {
    db.prepare('DELETE FROM stock_levels WHERE product_id = ?').run(id)
    db.prepare('DELETE FROM serials WHERE product_id = ?').run(id)
    db.prepare('DELETE FROM products WHERE id = ?').run(id)
  })()
  audit(ctx, 'delete', 'product', id, `Deleted product ${p.name}`)
  return { deleted: true }
}

/* ------------------------------ Categories ------------------------------ */

export function listCategories(ctx: Ctx): unknown[] {
  return ctx.db
    .prepare(
      `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS product_count
       FROM categories c WHERE ${visibleTo('c')} ORDER BY c.name`
    )
    .all({ firmId: ctx.firmId })
}

export function saveCategory(ctx: Ctx, input: { id?: number; name: string; kind?: string }): number {
  requirePerm(ctx, 'inventory.manage')
  const name = requireText(input.name, 'Category name', 80)
  const kind = input.kind === 'service' ? 'service' : 'goods'
  if (input.id) {
    ctx.db.prepare('UPDATE categories SET name = ?, kind = ? WHERE id = ?').run(name, kind, input.id)
    audit(ctx, 'update', 'category', input.id, `Updated category ${name}`)
    return input.id
  }
  const shared = getSetting(ctx.db, 'share_inventory', true)
  const id = Number(
    ctx.db.prepare('INSERT INTO categories (name, kind, firm_id) VALUES (?, ?, ?)').run(name, kind, shared ? null : ctx.firmId)
      .lastInsertRowid
  )
  audit(ctx, 'create', 'category', id, `Created category ${name}`)
  return id
}

export function deleteCategory(ctx: Ctx, id: number): void {
  requirePerm(ctx, 'inventory.manage')
  const used = ctx.db.prepare('SELECT 1 FROM products WHERE category_id = ? LIMIT 1').get(id)
  if (used) throw new AppError('This category has products. Move them to another category first.', 'VALIDATION')
  ctx.db.prepare('DELETE FROM categories WHERE id = ?').run(id)
  audit(ctx, 'delete', 'category', id, 'Deleted category')
}

/* ------------------------------ Warehouses ------------------------------ */

export function listWarehouses(ctx: Ctx, includeInactive = false): unknown[] {
  return ctx.db
    .prepare(
      `SELECT w.*, (SELECT COALESCE(SUM(sl.qty * p.avg_cost),0) FROM stock_levels sl JOIN products p ON p.id = sl.product_id
                    WHERE sl.warehouse_id = w.id AND sl.qty > 0) AS stock_value
       FROM warehouses w WHERE ${visibleTo('w')} ${includeInactive ? '' : 'AND w.is_active = 1'}
       ORDER BY w.is_default DESC, w.name`
    )
    .all({ firmId: ctx.firmId })
}

export function defaultWarehouseId(ctx: Ctx): number {
  const w = ctx.db
    .prepare(
      `SELECT id FROM warehouses w WHERE ${visibleTo('w')} AND w.is_active = 1
       ORDER BY (w.firm_id = @firmId) DESC, w.is_default DESC, w.id LIMIT 1`
    )
    .get({ firmId: ctx.firmId }) as { id: number } | undefined
  if (!w) throw new AppError('No warehouse found. Create a warehouse first.', 'VALIDATION')
  return w.id
}

export function assertWarehouseVisible(ctx: Ctx, id: number): void {
  const w = ctx.db.prepare(`SELECT id FROM warehouses w WHERE id = @id AND ${visibleTo('w')}`).get({ id, firmId: ctx.firmId })
  if (!w) throw new AppError('Warehouse is not available for this firm.', 'VALIDATION')
}

export function saveWarehouse(ctx: Ctx, input: { id?: number; name: string; address?: string; isActive?: boolean; shared?: boolean }): number {
  requirePerm(ctx, 'inventory.manage')
  const name = requireText(input.name, 'Warehouse name', 80)
  if (input.id) {
    if (input.isActive === false) {
      const hasStock = ctx.db.prepare('SELECT 1 FROM stock_levels WHERE warehouse_id = ? AND abs(qty) > 0.0005').get(input.id)
      if (hasStock) throw new AppError('Warehouse still has stock. Transfer it before deactivating.', 'VALIDATION')
    }
    ctx.db
      .prepare('UPDATE warehouses SET name = ?, address = ?, is_active = ? WHERE id = ?')
      .run(name, optText(input.address, 300), input.isActive === false ? 0 : 1, input.id)
    audit(ctx, 'update', 'warehouse', input.id, `Updated warehouse ${name}`)
    return input.id
  }
  const shared = input.shared ?? getSetting(ctx.db, 'share_inventory', true)
  const id = Number(
    ctx.db
      .prepare('INSERT INTO warehouses (firm_id, name, address) VALUES (?, ?, ?)')
      .run(shared ? null : ctx.firmId, name, optText(input.address, 300)).lastInsertRowid
  )
  audit(ctx, 'create', 'warehouse', id, `Created warehouse ${name}`)
  return id
}

/** Move stock between warehouses at current average cost (value-neutral). */
export function transferStock(
  ctx: Ctx,
  input: { date: string; fromWarehouseId: number; toWarehouseId: number; lines: Array<{ productId: number; qty: number }>; notes?: string }
): void {
  requirePerm(ctx, 'inventory.adjust')
  const date = requireDate(input.date)
  if (input.fromWarehouseId === input.toWarehouseId) throw new AppError('Select two different warehouses.', 'VALIDATION')
  assertWarehouseVisible(ctx, input.fromWarehouseId)
  assertWarehouseVisible(ctx, input.toWarehouseId)
  ctx.db.transaction(() => {
    const ref = Date.now()
    for (const l of input.lines ?? []) {
      const qty = round3(num(l.qty))
      if (qty <= 0) continue
      const base = { firmId: ctx.firmId, productId: l.productId, qty, date, refType: 'transfer', refId: ref, notes: optText(input.notes, 300), userId: ctx.user.id }
      const cost = stockOut(ctx.db, { ...base, warehouseId: input.fromWarehouseId }, { allowNegative: false })
      stockIn(ctx.db, { ...base, warehouseId: input.toWarehouseId, unitCost: cost })
    }
    audit(ctx, 'transfer', 'stock', null, `Stock transfer between warehouses`, input)
  })()
}

/* ------------------------------ Adjustments ------------------------------ */

export interface AdjustmentInput {
  date: string
  warehouseId: number
  kind?: 'opening' | 'adjustment'
  reason?: string
  notes?: string
  lines: Array<{ productId: number; qty: number; unitCost?: number; serials?: string; batchNo?: string }>
}

export function createAdjustment(ctx: Ctx, input: AdjustmentInput): number {
  requirePerm(ctx, 'inventory.adjust')
  const db = ctx.db
  const date = requireDate(input.date)
  const kind = input.kind === 'opening' ? 'opening' : 'adjustment'
  assertWarehouseVisible(ctx, input.warehouseId)
  const lines = (input.lines ?? []).filter((l) => l && l.productId && Math.abs(num(l.qty)) > 0)
  if (lines.length === 0) throw new AppError('Add at least one product with a quantity.', 'VALIDATION')
  return db.transaction(() => {
    const number = nextNumber(db, ctx.firmId, 'adjustment')
    const id = Number(
      db
        .prepare(
          `INSERT INTO stock_adjustments (firm_id, number, date, kind, warehouse_id, reason, notes, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(ctx.firmId, number, date, kind, input.warehouseId, optText(input.reason, 200), optText(input.notes, 1000), ctx.user.id)
        .lastInsertRowid
    )
    let total = 0
    for (const l of lines) {
      const p = getProductRow(db, l.productId)
      if (p.type === 'service') throw new AppError(`"${p.name}" is a service and has no stock.`, 'VALIDATION')
      const qty = round3(num(l.qty))
      if (kind === 'opening' && qty < 0) throw new AppError('Opening stock quantity must be positive.', 'VALIDATION')
      const serials = parseSerials(l.serials)
      checkSerialCount(p, Math.abs(qty), serials)
      const base: MoveInput = {
        firmId: ctx.firmId,
        productId: p.id,
        warehouseId: input.warehouseId,
        qty: Math.abs(qty),
        date,
        refType: kind === 'opening' ? 'opening' : 'adjustment',
        refId: id,
        refNumber: number,
        batchNo: optText(l.batchNo, 60),
        userId: ctx.user.id
      }
      let cost: number
      if (qty > 0) {
        cost = stockIn(db, { ...base, unitCost: num(l.unitCost, p.avg_cost || p.purchase_price) })
        if (serials.length) serialsIn(db, p.id, serials, { warehouseId: input.warehouseId, refType: base.refType, refId: id })
      } else {
        cost = stockOut(db, base, { allowNegative: false })
        if (serials.length) serialsOut(db, p.id, serials, { refType: base.refType, refId: id, status: 'returned', date, strict: true })
      }
      const value = round2(qty * cost)
      total += value
      db.prepare(
        'INSERT INTO stock_adjustment_lines (adjustment_id, product_id, qty, unit_cost, value, serials, batch_no) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(id, p.id, qty, cost, value, serials.join(', ') || null, optText(l.batchNo, 60))
    }
    db.prepare('UPDATE stock_adjustments SET total_value = ? WHERE id = ?').run(round2(total), id)
    audit(ctx, 'create', 'stock_adjustment', id, `${kind === 'opening' ? 'Opening stock' : 'Stock adjustment'} ${number}`, { lines })
    return id
  })()
}

export function listAdjustments(ctx: Ctx, f: { from?: string; to?: string } = {}): unknown[] {
  return ctx.db
    .prepare(
      `SELECT a.*, w.name AS warehouse_name, u.full_name AS created_by_name,
         (SELECT COUNT(*) FROM stock_adjustment_lines l WHERE l.adjustment_id = a.id) AS line_count
       FROM stock_adjustments a JOIN warehouses w ON w.id = a.warehouse_id LEFT JOIN users u ON u.id = a.created_by
       WHERE a.firm_id = @firmId AND (@from IS NULL OR a.date >= @from) AND (@to IS NULL OR a.date <= @to)
       ORDER BY a.date DESC, a.id DESC LIMIT 1000`
    )
    .all({ firmId: ctx.firmId, from: f.from ?? null, to: f.to ?? null })
}

export function getAdjustment(ctx: Ctx, id: number): unknown {
  const a = ctx.db
    .prepare(
      `SELECT a.*, w.name AS warehouse_name FROM stock_adjustments a JOIN warehouses w ON w.id = a.warehouse_id
       WHERE a.id = ? AND a.firm_id = ?`
    )
    .get(id, ctx.firmId)
  if (!a) throw new AppError('Adjustment not found.', 'NOT_FOUND')
  const lines = ctx.db
    .prepare(
      `SELECT l.*, p.name AS product_name, p.unit FROM stock_adjustment_lines l JOIN products p ON p.id = l.product_id
       WHERE l.adjustment_id = ?`
    )
    .all(id)
  return { ...(a as object), lines }
}

export function listMovements(
  ctx: Ctx,
  f: { productId?: number; warehouseId?: number; from?: string; to?: string; refType?: string; limit?: number }
): unknown[] {
  return ctx.db
    .prepare(
      `SELECT m.*, p.name AS product_name, p.unit, w.name AS warehouse_name, f.name AS firm_name, pr.name AS project_name
       FROM stock_movements m JOIN products p ON p.id = m.product_id JOIN warehouses w ON w.id = m.warehouse_id
       JOIN firms f ON f.id = m.firm_id LEFT JOIN projects pr ON pr.id = m.project_id
       WHERE (w.firm_id IS NULL OR w.firm_id = @firmId)
         AND (@productId IS NULL OR m.product_id = @productId)
         AND (@warehouseId IS NULL OR m.warehouse_id = @warehouseId)
         AND (@from IS NULL OR m.date >= @from) AND (@to IS NULL OR m.date <= @to)
         AND (@refType IS NULL OR m.ref_type = @refType)
       ORDER BY m.date DESC, m.id DESC LIMIT @limit`
    )
    .all({
      firmId: ctx.firmId,
      productId: f.productId ?? null,
      warehouseId: f.warehouseId ?? null,
      from: f.from ?? null,
      to: f.to ?? null,
      refType: f.refType ?? null,
      limit: Math.min(f.limit ?? 500, 5000)
    })
}

export function lookupSerial(ctx: Ctx, serial: string): unknown[] {
  const s = requireText(serial, 'Serial number', 100)
  return ctx.db
    .prepare(
      `SELECT s.*, p.name AS product_name, p.warranty_months, p.warranty_terms, pa.name AS party_name, pr.name AS project_name,
         w.name AS warehouse_name,
         (SELECT d.number FROM documents d WHERE s.out_ref_type = d.doc_type AND d.id = s.out_ref_id) AS out_doc_number,
         (SELECT d.number FROM documents d WHERE s.in_ref_type = d.doc_type AND d.id = s.in_ref_id) AS in_doc_number
       FROM serials s JOIN products p ON p.id = s.product_id
       LEFT JOIN parties pa ON pa.id = s.party_id LEFT JOIN projects pr ON pr.id = s.project_id
       LEFT JOIN warehouses w ON w.id = s.warehouse_id
       WHERE s.serial LIKE ? ESCAPE '\\' ORDER BY s.serial LIMIT 100`
    )
    .all(like(s))
}

export function stockReport(ctx: Ctx, f: { warehouseId?: number; categoryId?: number; includeZero?: boolean } = {}): unknown {
  const showCost = can(ctx, 'inventory.cost')
  const rows = ctx.db
    .prepare(
      `SELECT p.id, p.name, p.sku, p.unit, p.reorder_level, c.name AS category_name, p.avg_cost, p.sale_price,
         COALESCE((SELECT SUM(sl.qty) FROM stock_levels sl JOIN warehouses w ON w.id = sl.warehouse_id
           WHERE sl.product_id = p.id AND (w.firm_id IS NULL OR w.firm_id = @firmId)
             AND (@wh IS NULL OR sl.warehouse_id = @wh)), 0) AS qty
       FROM products p LEFT JOIN categories c ON c.id = p.category_id
       WHERE p.type = 'goods' AND ${visibleTo('p')} AND (@cat IS NULL OR p.category_id = @cat)
       ORDER BY c.name, p.name`
    )
    .all({ firmId: ctx.firmId, wh: f.warehouseId ?? null, cat: f.categoryId ?? null }) as Array<Record<string, number | string | null>>
  const out = rows
    .filter((r) => f.includeZero || Math.abs(Number(r.qty)) > 0.0005)
    .map((r) => {
      const qty = round3(Number(r.qty))
      const value = round2(Math.max(0, qty) * Number(r.avg_cost))
      return {
        ...r,
        qty,
        avg_cost: showCost ? r.avg_cost : null,
        value: showCost ? value : null,
        sale_value: round2(Math.max(0, qty) * Number(r.sale_price))
      }
    })
  const totalValue = showCost ? round2(out.reduce((a, r) => a + (r.value ?? 0), 0)) : null
  const totalSaleValue = round2(out.reduce((a, r) => a + r.sale_value, 0))
  return { rows: out, totalValue, totalSaleValue, method: 'Moving weighted average cost' }
}

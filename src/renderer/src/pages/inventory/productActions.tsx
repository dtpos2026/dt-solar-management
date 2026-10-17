/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Product delete / archive / restore and category re-assignment flows (Inventory).
 * The main process decides: a never-used product is deleted, a product with any history is archived.
 */
import { useEffect, useState } from 'react'
import { Tags, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { Button, Field, Modal, Select, confirmDialog, toast } from '../../components/ui'

export interface ProductUsage {
  id: number
  name: string
  is_active: number
  documents: number
  movements: number
  adjustments: number
  materialMoves: number
  serials: number
  stockQty: number
  used: boolean
  reason: string | null
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/**
 * Delete a product: checks its usage first and tells the user exactly what will happen
 * (permanent delete for an unused product, archive for one with history).
 * Returns true when something changed.
 */
export async function deleteProductFlow(p: { id: number; name: string }): Promise<boolean> {
  let u: ProductUsage
  try {
    u = await api<ProductUsage>('products.usage', { id: p.id })
  } catch (e) {
    toast.error(e)
    return false
  }
  if (!u.used) {
    const ok = await confirmDialog({
      title: `Delete “${u.name}” permanently?`,
      message: 'This product has never been used on any invoice, purchase, quotation, stock entry or project, so it can be removed completely. This cannot be undone.',
      confirmLabel: 'Delete permanently',
      danger: true
    })
    if (!ok) return false
  } else if (!u.is_active) {
    await confirmDialog({
      title: `“${u.name}” cannot be deleted`,
      message: (
        <>
          {u.reason} Products with history are never deleted, so your invoices, stock valuation and reports stay correct.
          It is already <b>archived</b> (hidden from new documents). You can restore it from the archived list.
        </>
      ),
      confirmLabel: 'OK'
    })
    return false
  } else {
    const ok = await confirmDialog({
      title: `“${u.name}” cannot be deleted - archive it instead?`,
      message: (
        <>
          {u.reason}
          <br />
          <br />
          To keep your invoices, stock and reports correct it will be <b>archived</b> instead: it disappears from new sales, purchases,
          quotations and project material issues, but every past record still shows it. You can restore it at any time.
          {Math.abs(u.stockQty) > 0.0005 && (
            <>
              <br />
              <br />
              <b>Note:</b> {u.stockQty} unit(s) are still in stock and stay in your stock valuation.
            </>
          )}
        </>
      ),
      confirmLabel: 'Archive product'
    })
    if (!ok) return false
  }
  try {
    const r = await api<{ deleted: boolean; archived: boolean; message: string }>('products.delete', { id: p.id })
    if (r.deleted) toast.ok(`“${u.name}” was deleted permanently.`)
    else toast.ok(`“${u.name}” was archived (it has history, so it was not deleted).`)
    return true
  } catch (e) {
    toast.error(e)
    return false
  }
}

/** Archive one or more products (with a confirmation). Returns true when something changed. */
export async function archiveProductsFlow(ids: number[], label: string): Promise<boolean> {
  const ok = await confirmDialog({
    title: `Archive ${label}?`,
    message:
      'Archived products are hidden from new sales, purchases, quotations and project material issues. Past invoices, stock movements and reports keep showing them, and you can restore them at any time.',
    confirmLabel: 'Archive'
  })
  if (!ok) return false
  try {
    const r = await api<{ archived: number; withStock: Array<{ id: number; name: string; qty: number }> }>('products.archive', { ids })
    toast.ok(r.archived ? `${plural(r.archived, 'product')} archived.` : 'Nothing to archive - already archived.')
    if (r.withStock.length) {
      const names = r.withStock.slice(0, 3).map((s) => `${s.name} (${s.qty})`).join(', ')
      toast.warn(`${plural(r.withStock.length, 'archived product')} still ${r.withStock.length === 1 ? 'has' : 'have'} stock: ${names}${r.withStock.length > 3 ? '…' : ''}. It stays in your stock value; restore to sell it.`)
    }
    return true
  } catch (e) {
    toast.error(e)
    return false
  }
}

export async function restoreProductsFlow(ids: number[]): Promise<boolean> {
  try {
    const r = await api<{ restored: number }>('products.restore', { ids })
    toast.ok(r.restored ? `${plural(r.restored, 'product')} restored - available on new documents again.` : 'Nothing to restore.')
    return true
  } catch (e) {
    toast.error(e)
    return false
  }
}

/** Bulk "Change category". */
export function CategoryPickModal({ open, ids, categories, onClose, onDone }: { open: boolean; ids: number[]; categories: any[]; onClose: () => void; onDone: () => void }): JSX.Element {
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (open) setTarget('')
  }, [open])
  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      const categoryId = target === 'none' ? null : Number(target)
      const r = await api<{ changed: number }>('products.setCategory', { ids, categoryId })
      const name = categoryId ? categories.find((c) => c.id === categoryId)?.name : 'No category'
      toast.ok(r.changed ? `${plural(r.changed, 'product')} moved to “${name}”.` : `The selected products are already in “${name}”.`)
      onDone()
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      title={`Change category of ${plural(ids.length, 'product')}`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" icon={<Tags className="h-4 w-4" />} loading={busy} disabled={!target} onClick={save}>
            Move products
          </Button>
        </>
      }
    >
      <Field label="New category">
        <Select autoFocus value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose a category…</option>
          <option value="none">No category</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      </Field>
      <p className="mt-3 text-[12.5px] text-muted">Only the grouping changes. Stock quantities, average costs, past invoices and report totals are not affected.</p>
    </Modal>
  )
}

/** Delete a category; if it still has products they are moved to another category (or none) in the same step. */
export function DeleteCategoryModal({ category, categories, onClose, onDone }: { category: any | null; categories: any[]; onClose: () => void; onDone: () => void }): JSX.Element {
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => setTarget(''), [category])
  const count = Number(category?.product_count ?? 0)
  const archived = count - Number(category?.active_count ?? 0)
  const others = categories.filter((c) => c.id !== category?.id)
  const save = async (): Promise<void> => {
    if (!category) return
    setBusy(true)
    try {
      const args = count === 0 ? { id: category.id } : target === 'none' ? { id: category.id, clearCategory: true } : { id: category.id, moveToCategoryId: Number(target) }
      const r = await api<{ moved: number }>('categories.delete', args)
      toast.ok(r.moved ? `Category “${category.name}” deleted; ${plural(r.moved, 'product')} moved.` : `Category “${category.name}” deleted.`)
      onDone()
      onClose()
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Modal
      open={!!category}
      onClose={onClose}
      size="sm"
      title={`Delete category “${category?.name ?? ''}”?`}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} loading={busy} disabled={count > 0 && !target} onClick={save}>
            {count > 0 ? `Move ${plural(count, 'product')} & delete` : 'Delete category'}
          </Button>
        </>
      }
    >
      {count === 0 ? (
        <p className="text-[13.5px] text-muted">This category has no products. It will be removed.</p>
      ) : (
        <div className="space-y-3 text-[13.5px]">
          <p className="text-muted">
            <b className="text-ink">{plural(count, 'product')}</b>
            {archived > 0 ? ` (${archived} archived)` : ''} {count === 1 ? 'is' : 'are'} in this category. Choose where to move {count === 1 ? 'it' : 'them'} - the
            products are moved and the category is deleted in one step.
          </p>
          <Field label="Move products to">
            <Select autoFocus value={target} onChange={(e) => setTarget(e.target.value)}>
              <option value="">Choose a category…</option>
              {others.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
              <option value="none">No category</option>
            </Select>
          </Field>
          <p className="text-[12.5px] text-muted">Stock, average costs, invoices and reports are not changed - only the grouping of these products.</p>
        </div>
      )}
    </Modal>
  )
}


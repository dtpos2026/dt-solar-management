import { Fragment, useEffect, useState } from 'react'
import { api } from '../api'
import { today } from '../lib/format'
import { round2 } from '@shared/money'
import { Letterhead, PrintFooter, PrintTable, Sheet, Signatures, TemplateProps, pd, pm, pq } from './PrintKit'

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Group {
  name: string
  rows: any[]
  value: number
  saleValue: number
}

const posNum = (v: string | undefined): number | undefined => {
  const n = Number(v)
  return v && Number.isFinite(n) && n > 0 ? n : undefined
}

/** Stock valuation report (current stock, at cost and at sale price), grouped by category. */
export function StockPrint({ params, ctx, setTitle }: TemplateProps): JSX.Element | null {
  const warehouseId = posNum(params.warehouseId)
  const categoryId = posNum(params.categoryId)
  const includeZero = params.includeZero === '1' || params.includeZero === 'true'
  const [data, setData] = useState<{ report: any; warehouse: string; category: string | null } | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    const whName = warehouseId
      ? api<any[]>('warehouses.list', { includeInactive: true })
          .then((ws) => ws.find((w) => w.id === warehouseId)?.name ?? `Warehouse #${warehouseId}`)
          .catch(() => `Warehouse #${warehouseId}`)
      : Promise.resolve('All warehouses')
    Promise.all([api<any>('stock.report', { warehouseId, categoryId, includeZero }), whName])
      .then(([report, warehouse]) => {
        const category = categoryId ? (report.rows?.[0]?.category_name ?? null) : null
        setData({ report, warehouse, category })
        setTitle(`Stock Valuation ${pd(today())} - ${warehouse}`)
      })
      .catch((e) => setErr(e.message))
  }, [warehouseId, categoryId, includeZero]) // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="no-print mx-auto max-w-[210mm] rounded bg-red-100 p-4 text-red-800">{err}</div>
  if (!data) return null

  const R = data.report
  const rows: any[] = R.rows ?? []
  // Cost figures come back as null when the user lacks "inventory.cost".
  const showCost = R.totalValue !== null && R.totalValue !== undefined
  const groupMap = new Map<string, Group>()
  for (const r of rows) {
    const name = r.category_name || 'Uncategorised'
    const g: Group = groupMap.get(name) ?? { name, rows: [], value: 0, saleValue: 0 }
    g.rows.push(r)
    g.value = round2(g.value + Number(r.value || 0))
    g.saleValue = round2(g.saleValue + Number(r.sale_value || 0))
    groupMap.set(name, g)
  }
  const groups = [...groupMap.values()].sort((a, b) => (a.name === 'Uncategorised' ? 1 : b.name === 'Uncategorised' ? -1 : a.name.localeCompare(b.name)))
  for (const g of groups) g.rows.sort((a, b) => String(a.name).localeCompare(String(b.name)))
  const multiGroup = groups.length > 1
  const colCount = showCost ? 8 : 6
  const lowCount = rows.filter((r) => Number(r.reorder_level) > 0 && Number(r.qty) <= Number(r.reorder_level)).length
  const negCount = rows.filter((r) => Number(r.qty) < 0).length
  const margin = showCost ? round2(Number(R.totalSaleValue) - Number(R.totalValue)) : null

  const tiles: Array<{ label: string; value: string; sub?: string; accent?: boolean }> = [
    { label: 'Products in stock', value: String(rows.length), sub: `${groups.length} categor${groups.length === 1 ? 'y' : 'ies'}` },
    showCost ? { label: 'Value at cost', value: pm(ctx, R.totalValue, 2), sub: 'Moving average cost', accent: true } : null,
    { label: 'Value at sale price', value: pm(ctx, R.totalSaleValue, 2), sub: 'Current sale prices' },
    showCost
      ? { label: 'Potential gross margin', value: pm(ctx, margin, 2), sub: Number(R.totalSaleValue) > 0 ? `${((Number(margin) / Number(R.totalSaleValue)) * 100).toFixed(1)}% of sale value` : undefined }
      : { label: 'Low / negative stock', value: `${lowCount} / ${negCount}`, sub: 'At or below reorder level' }
  ].filter(Boolean) as Array<{ label: string; value: string; sub?: string; accent?: boolean }>

  const sub = { background: '#eef2f7' }
  let serial = 0
  const head = { background: 'color-mix(in srgb, var(--pc) 10%, #fff)' }

  return (
    <Sheet ctx={ctx}>
      <Letterhead
        ctx={ctx}
        title="Stock Valuation"
        subtitle="Inventory on hand"
        meta={[
          ['As of', pd(today())],
          ['Warehouse', data.warehouse],
          ...(data.category ? ([['Category', data.category]] as Array<[string, string]>) : []),
          ['Method', showCost ? String(R.method ?? 'Moving weighted average cost') : 'Sale price only']
        ]}
      />

      <div className={`avoid-break mb-3 grid gap-2 ${tiles.length === 4 ? 'grid-cols-4' : 'grid-cols-3'}`}>
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
            <th style={{ width: 26 }}>#</th>
            <th>Product</th>
            <th style={{ width: 64 }} className="!text-right">Qty</th>
            <th style={{ width: 44 }}>Unit</th>
            {showCost && <th style={{ width: 76 }} className="!text-right">Avg cost</th>}
            {showCost && <th style={{ width: 90 }} className="!text-right">Value at cost</th>}
            <th style={{ width: 76 }} className="!text-right">Sale price</th>
            <th style={{ width: 92 }} className="!text-right">Value at sale</th>
          </>
        }
      >
        {rows.length === 0 && (
          <tr>
            <td colSpan={colCount} className="py-4 text-center text-[#718096]">No stock on hand{data.warehouse !== 'All warehouses' ? ` in ${data.warehouse}` : ''}.</td>
          </tr>
        )}
        {groups.map((g) => (
          <Fragment key={g.name}>
            {multiGroup && (
              <tr>
                <td colSpan={colCount} className="font-bold" style={{ ...head, color: 'var(--pc)' }}>
                  {g.name} <span className="font-normal text-[#718096]">· {g.rows.length} item{g.rows.length === 1 ? '' : 's'}</span>
                </td>
              </tr>
            )}
            {g.rows.map((r) => {
              const qty = Number(r.qty)
              const low = Number(r.reorder_level) > 0 && qty <= Number(r.reorder_level)
              return (
                <tr key={r.id}>
                  <td className="text-[#718096]">{++serial}</td>
                  <td>
                    <div className="font-semibold">{r.name}</div>
                    {(r.sku || low || qty < 0) && (
                      <div className="text-[9.5px] text-[#4a5568]">
                        {r.sku && <span>SKU: {r.sku}</span>}
                        {qty < 0 ? (
                          <span className="ml-1.5 font-semibold text-[#c53030]">Negative stock</span>
                        ) : (
                          low && <span className="ml-1.5 font-semibold text-[#c05621]">Low (reorder at {pq(r.reorder_level)})</span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className={`num text-right font-semibold ${qty < 0 ? 'text-[#c53030]' : ''}`}>{pq(qty)}</td>
                  <td>{r.unit ?? ''}</td>
                  {showCost && <td className="num text-right">{pm(ctx, r.avg_cost, 2)}</td>}
                  {showCost && <td className="num text-right">{pm(ctx, r.value, 2)}</td>}
                  <td className="num text-right">{pm(ctx, r.sale_price, 2)}</td>
                  <td className="num text-right">{pm(ctx, r.sale_value, 2)}</td>
                </tr>
              )
            })}
            {multiGroup && (
              <tr className="font-semibold">
                <td colSpan={showCost ? 5 : 4} className="text-right" style={sub}>
                  Subtotal - {g.name}
                </td>
                {showCost && <td className="num text-right" style={sub}>{pm(ctx, g.value, 2)}</td>}
                <td style={sub} />
                <td className="num text-right" style={sub}>{pm(ctx, g.saleValue, 2)}</td>
              </tr>
            )}
          </Fragment>
        ))}
        {rows.length > 0 && (
          <tr className="font-bold text-white">
            <td colSpan={showCost ? 5 : 4} className="text-right text-[11.5px]" style={{ background: 'var(--pc)' }}>
              Grand total ({rows.length} product{rows.length === 1 ? '' : 's'})
            </td>
            {showCost && <td className="num text-right text-[11.5px]" style={{ background: 'var(--pc)' }}>{pm(ctx, R.totalValue, 2)}</td>}
            <td style={{ background: 'var(--pc)' }} />
            <td className="num text-right text-[11.5px]" style={{ background: 'var(--pc)' }}>{pm(ctx, R.totalSaleValue, 2)}</td>
          </tr>
        )}
      </PrintTable>

      <div className="avoid-break mt-3 text-[9.5px] leading-relaxed text-[#718096]">
        {showCost
          ? `Valuation method: ${R.method ?? 'Moving weighted average cost'}. Value at cost = quantity on hand × average cost; value at sale = quantity × current sale price. Negative quantities are valued at zero. `
          : 'Cost figures are not included in this report. Value at sale = quantity on hand × current sale price. '}
        Services and non-stock items are excluded{includeZero ? '' : '; products with zero stock are not listed'}.
      </div>

      <Signatures ctx={ctx} left="Checked by (store keeper)" right={ctx.ps.signatureLabel} />
      <PrintFooter ctx={ctx} />
    </Sheet>
  )
}

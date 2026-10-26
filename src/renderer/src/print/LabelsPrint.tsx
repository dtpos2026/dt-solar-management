/**
 * Barcode label sheet: A4, 3 columns by 8 rows. Opened with
 * api('print.open', { kind: 'labels', id: 0, params: { ids: '3,5,9', copies: 2 } }). Products without a barcode are skipped
 * (assign barcodes first from the Inventory screen).
 */
import { useEffect, useState } from 'react'
import { api } from '../api'
import { code128Svg } from '@shared/code128'
import { TemplateProps, Sheet, pm } from './PrintKit'

/* eslint-disable @typescript-eslint/no-explicit-any */
const COLS = 3
const ROWS = 8

export function LabelsPrint({ ctx, params, setTitle }: TemplateProps): JSX.Element | null {
  const [labels, setLabels] = useState<any[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    const ids = new Set(String(params.ids ?? '').split(',').map(Number).filter(Boolean))
    const copies = Math.min(100, Math.max(1, Number(params.copies ?? 1) || 1))
    api<{ rows: any[] }>('products.list', { limit: 5000, active: 'all' })
      .then((r) => {
        const picked = r.rows.filter((p) => ids.has(p.id) && p.barcode)
        if (!picked.length) throw new Error('None of the selected items has a barcode yet. Assign barcodes first.')
        setLabels(picked.flatMap((p) => Array.from({ length: copies }, () => p)))
        setTitle('Barcode labels')
      })
      .catch((e) => setErr(e.message))
  }, [params.ids, params.copies]) // eslint-disable-line react-hooks/exhaustive-deps
  if (err) return <div className="no-print mx-auto max-w-[210mm] rounded bg-red-100 p-4 text-red-800">{err}</div>
  if (!labels) return null
  const perPage = COLS * ROWS
  const pages: any[][] = []
  for (let i = 0; i < labels.length; i += perPage) pages.push(labels.slice(i, i + perPage))
  const showPrice = params.price !== '0'
  return (
    <Sheet ctx={ctx} className="!p-0">
      {pages.map((page, pi) => (
        <div key={pi} className="grid" style={{ gridTemplateColumns: `repeat(${COLS}, 70mm)`, gridAutoRows: '37mm', justifyContent: 'center', breakAfter: pi < pages.length - 1 ? 'page' : 'auto' }}>
          {page.map((p, i) => (
            <div key={i} className="flex flex-col items-center justify-center overflow-hidden px-2 text-center" style={{ height: '37mm', border: '0.1mm dashed #cbd5e0' }}>
              <div className="w-full truncate text-[8.5px] font-semibold leading-tight">{p.name}</div>
              <div className="my-0.5 w-full [&>svg]:block [&>svg]:h-[14mm] [&>svg]:w-full" dangerouslySetInnerHTML={{ __html: code128Svg(String(p.barcode), { height: 40 }) }} />
              <div className="num text-[8.5px] tracking-[0.15em]">{p.barcode}</div>
              {showPrice && <div className="num text-[11px] font-extrabold">{pm(ctx, p.sale_price, 0)}</div>}
            </div>
          ))}
        </div>
      ))}
    </Sheet>
  )
}

import { useEffect, useState, ComponentType } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { FileDown, Printer, X, Loader2 } from 'lucide-react'
import { api } from '../api'
import { PrintContext, TemplateProps } from './PrintKit'
import { DocumentPrint } from './DocumentPrint'
import { PaymentPrint } from './PaymentPrint'
import { StatementPrint } from './StatementPrint'
import { ProjectPrint } from './ProjectPrint'
import { MaterialPrint } from './MaterialPrint'
import { StockPrint } from './StockPrint'
import { ReportPrint } from './ReportPrint'

/* eslint-disable @typescript-eslint/no-explicit-any */
const TEMPLATES: Record<string, ComponentType<TemplateProps>> = {
  doc: DocumentPrint,
  payment: PaymentPrint,
  statement: StatementPrint,
  project: ProjectPrint,
  material: MaterialPrint,
  stock: StockPrint,
  report: ReportPrint
}

/** Print preview window: A4 sheets on a grey desk with a screen-only toolbar. */
export function PrintView(): JSX.Element {
  const { kind = 'doc', id = '0' } = useParams()
  const [search] = useSearchParams()
  const [ctx, setCtx] = useState<PrintContext | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('Document')
  const [busy, setBusy] = useState<'print' | 'pdf' | null>(null)
  const params = Object.fromEntries(search.entries())

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'solar')
    Promise.all([api<any>('firms.get', {}), api<any>('settings.get')])
      .then(([firm, settings]) => setCtx({ firm, settings, ps: firm.print_settings }))
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    document.title = title
  }, [title])

  const Template = TEMPLATES[kind]
  const run = async (what: 'print' | 'pdf'): Promise<void> => {
    setBusy(what)
    try {
      // Contract with the print routes: kind selects the configured printer, paper the page size.
      const paper = params.paper || undefined
      if (what === 'print') await api('print.run', { kind, paper })
      else await api('print.pdf', { filename: title, kind, paper })
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="print-root" data-print-ready={ctx && title !== 'Document' ? '1' : undefined}>
      <div className="no-print fixed inset-x-0 top-0 z-50 flex h-14 items-center gap-3 bg-[#2b2d31] px-5 text-white shadow-lg">
        <div className="mr-auto truncate font-semibold">{title}</div>
        <span className="hidden text-[12px] text-white/60 md:inline">A4 · Preview matches the printed page</span>
        <button type="button" onClick={() => run('print')} disabled={!!busy || !ctx} className="flex h-9 items-center gap-2 rounded-lg bg-[#2f5bea] px-4 font-medium hover:brightness-110 disabled:opacity-50 cursor-pointer">
          {busy === 'print' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />} Print
        </button>
        <button type="button" onClick={() => run('pdf')} disabled={!!busy || !ctx} className="flex h-9 items-center gap-2 rounded-lg bg-white/10 px-4 font-medium hover:bg-white/20 disabled:opacity-50 cursor-pointer">
          {busy === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />} Save PDF
        </button>
        <button type="button" onClick={() => window.close()} className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-white/10 cursor-pointer" title="Close">
          <X className="h-5 w-5" />
        </button>
      </div>
      {error && <div className="no-print mx-auto mb-4 max-w-[210mm] rounded-lg bg-red-100 px-4 py-3 text-red-800">{error}</div>}
      {!ctx ? (
        !error && <div className="no-print flex justify-center py-20 text-white/70"><Loader2 className="h-6 w-6 animate-spin" /></div>
      ) : Template ? (
        <Template id={Number(id)} params={params} ctx={ctx} setTitle={setTitle} />
      ) : (
        <div className="no-print text-center text-white">Unknown document type.</div>
      )}
    </div>
  )
}

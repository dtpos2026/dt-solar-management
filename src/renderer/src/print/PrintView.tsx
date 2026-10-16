import { useCallback, useEffect, useMemo, useRef, useState, ComponentType } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { FileDown, Printer, X, Loader2, SlidersHorizontal, RotateCcw, Save, Files } from 'lucide-react'
import { api } from '../api'
import { useCan } from '../store'
import { Button, Checkbox, Field, Input, Modal, toast } from '../components/ui'
import { PrintContext, TemplateProps } from './PrintKit'
import { DocumentPrint } from './DocumentPrint'
import { PaymentPrint } from './PaymentPrint'
import { StatementPrint } from './StatementPrint'
import { ProjectPrint } from './ProjectPrint'
import { MaterialPrint } from './MaterialPrint'
import { StockPrint } from './StockPrint'
import { ReportPrint } from './ReportPrint'
import { DesignControls, DesignValue } from './DesignControls'
import { KIND_LABELS, LAYOUT_LABEL, PrintDesign, SavedTemplate, TemplateKind, THERMAL_KINDS, builtinLayouts, resolveDesign, sameOptions } from './design'
import { ClosingPrint } from './ClosingPrint'
import { SHEET_MM, sheetPageCss, type Orientation, type SheetPaper } from './pageRules'

/* eslint-disable @typescript-eslint/no-explicit-any */
const TEMPLATES: Record<string, ComponentType<TemplateProps>> = {
  doc: DocumentPrint,
  payment: PaymentPrint,
  statement: StatementPrint,
  project: ProjectPrint,
  material: MaterialPrint,
  stock: StockPrint,
  report: ReportPrint,
  closing: ClosingPrint
}

/** Print routes whose look comes from a print template (customer documents and payment receipts). */
const DESIGNABLE = new Set(['doc', 'payment'])
const PANEL_W = 340

interface KindTemplates {
  kind: TemplateKind
  templates: SavedTemplate[]
  defaultRef: number | string
}

/**
 * Print preview window: A4 sheets (or an 80 mm receipt) on a grey desk with a screen-only toolbar.
 * Customer documents get a template selector and a "Customise this print" panel. Template choices and temporary
 * changes only affect this print — the stored document never changes.
 */
export function PrintView(): JSX.Element {
  const { kind = 'doc', id = '0' } = useParams()
  const [search] = useSearchParams()
  const can = useCan()
  const [ctx, setCtx] = useState<PrintContext | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('Document')
  const [busy, setBusy] = useState<'print' | 'pdf' | 'view' | null>(null)
  const [orientation, setOrientation] = useState<Orientation>('portrait')
  const userOriented = useRef(false)
  const [pages, setPages] = useState<number | null>(null)
  const params = useMemo(() => Object.fromEntries(search.entries()), [search])
  const designable = DESIGNABLE.has(kind)

  const [tkind, setTkind] = useState<TemplateKind | null>(null)
  const [kt, setKt] = useState<KindTemplates | null>(null)
  const [ref, setRef] = useState<string>('')
  const [design, setDesign] = useState<PrintDesign | null>(null)
  const [panel, setPanel] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', 'solar')
    Promise.all([api<any>('firms.get', {}), api<any>('settings.get'), api<any>('license.status').catch(() => null)])
      .then(([firm, settings, lic]) => setCtx({ firm, settings, ps: firm.print_settings, poweredBy: lic?.poweredBy === true }))
      .catch((e) => setError(e.message))
  }, [])

  useEffect(() => {
    document.title = title
  }, [title])

  const base = useMemo(() => (ctx && kt ? resolveDesign(ref, kt.templates, kt.kind, ctx.ps) : null), [ctx, kt, ref])

  const loadTemplates = useCallback(
    async (k: TemplateKind, selectRef?: string): Promise<void> => {
      let res: KindTemplates
      try {
        res = await api<KindTemplates>('templates.forKind', { kind: k })
      } catch (e) {
        // Printing must still work: fall back to the built-in Classic layout.
        setError(`Templates could not be loaded (${(e as Error).message}). Using the built-in Classic layout.`)
        res = { kind: k, templates: [], defaultRef: 'builtin:classic' }
      }
      setKt(res)
      let initial = selectRef ?? params.template ?? String(res.defaultRef)
      // A thermal printer chosen for this print (paper=thermal80) starts on the receipt layout unless a receipt template is the default.
      if (!selectRef && !params.template && params.paper === 'thermal80' && THERMAL_KINDS.includes(k)) {
        const def = resolveDesign(res.defaultRef, res.templates, k, undefined)
        if (def.layout !== 'thermal80') initial = 'builtin:thermal80'
      }
      setRef(initial)
    },
    [params.template, params.paper]
  )

  useEffect(() => {
    if (designable && tkind && ctx) void loadTemplates(tkind)
  }, [designable, tkind, ctx]) // eslint-disable-line react-hooks/exhaustive-deps

  // Selecting another template drops temporary changes.
  useEffect(() => {
    if (base) setDesign(base)
  }, [base])

  const onKind = useCallback((k: TemplateKind) => setTkind(k), [])

  const thermal = designable && design?.layout === 'thermal80'
  // Print contract: kind selects the configured printer, paper the page size (set from the chosen template).
  const paper = designable ? (thermal ? 'thermal80' : params.paper && !params.paper.startsWith('thermal') ? params.paper : 'A4') : params.paper || undefined
  const customised = !!(design && base && (design.layout !== base.layout || !sameOptions(design.options, base.options)))

  const sheetPaper: SheetPaper = paper && paper in SHEET_MM ? (paper as SheetPaper) : 'A4'
  const orient: Orientation = thermal ? 'portrait' : orientation

  const Template = TEMPLATES[kind]
  const run = async (what: 'print' | 'pdf' | 'view'): Promise<void> => {
    setBusy(what)
    try {
      if (what === 'print') await api('print.run', { kind, paper, orientation: orient })
      else if (what === 'pdf') await api('print.pdf', { filename: title, kind, paper, orientation: orient })
      else {
        // Page view: the exact pages Save PDF and the printer produce, in the built-in PDF viewer.
        const r = await api<{ pages: number }>('print.pdf', { filename: title, kind, paper, orientation: orient, view: true })
        if (r?.pages) setPages(r.pages)
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const ready = !!ctx && title !== 'Document' && (!designable || !!design)

  // Wide reports: when a portrait sheet cannot hold its content (a table wider than the page), turn it sideways
  // automatically — unless the user picked the orientation.
  useEffect(() => {
    if (!ready || thermal || userOriented.current || orientation === 'landscape') return
    const t = setTimeout(() => {
      const wide = Array.from(document.querySelectorAll<HTMLElement>('.print-root .sheet')).some((el) => el.scrollWidth > el.clientWidth + 4)
      if (wide) setOrientation('landscape')
    }, 300)
    return () => clearTimeout(t)
  }, [ready, thermal, orientation, design, title])

  // Page count of the real PDF (same pagination as Save PDF / Print), refreshed when the layout changes.
  useEffect(() => {
    setPages(null)
    if (!ready || thermal) return
    let live = true
    const t = setTimeout(() => {
      api<{ pages: number }>('print.pdf', { kind, paper, orientation: orient, count: true })
        .then((r) => live && setPages(r?.pages ?? null))
        .catch(() => undefined)
    }, 900)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [ready, thermal, kind, paper, orient, design, title]) // eslint-disable-line react-hooks/exhaustive-deps
  const options: Array<{ value: string; label: string }> = kt
    ? [
        ...kt.templates.map((t) => ({ value: String(t.id), label: `${t.name} — ${LAYOUT_LABEL[t.layout]}${String(kt.defaultRef) === String(t.id) ? ' (default)' : ''}` })),
        ...builtinLayouts(kt.kind).map((l) => ({ value: `builtin:${l}`, label: `Built-in ${LAYOUT_LABEL[l]}${String(kt.defaultRef) === `builtin:${l}` ? ' (default)' : ''}` }))
      ]
    : []

  return (
    <div className={`print-root ${orient === 'landscape' ? 'print-landscape' : ''}`} data-print-ready={ready ? '1' : undefined} data-orientation={orient} data-pages={pages ?? undefined}>
      {!thermal && <style>{sheetPageCss(sheetPaper, orient)}</style>}
      <div className="no-print fixed inset-x-0 top-0 z-50 flex h-14 items-center gap-2.5 bg-[#2b2d31] px-4 text-white shadow-lg">
        <div className="mr-auto min-w-0 truncate font-semibold">{title}</div>
        {designable && kt && (
          <label className="flex items-center gap-2 text-[12.5px] text-white/70">
            <span className="hidden lg:inline">Template</span>
            <select
              aria-label="Print template"
              data-testid="template-select"
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              className="h-9 max-w-[250px] rounded-lg border border-white/20 bg-[#3a3d42] px-2 text-[13px] text-white outline-none focus:border-white/50 cursor-pointer"
            >
              {options.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        )}
        {designable && kt && (
          <button
            type="button"
            onClick={() => setPanel((p) => !p)}
            className={`flex h-9 items-center gap-2 rounded-lg px-3 font-medium cursor-pointer ${panel ? 'bg-white text-[#2b2d31]' : 'bg-white/10 hover:bg-white/20'}`}
            title="Temporarily change what this print shows"
          >
            <SlidersHorizontal className="h-4 w-4" /> Customise{customised ? ' •' : ''}
          </button>
        )}
        {!thermal && (
          <select
            aria-label="Page orientation"
            data-testid="orientation-select"
            value={orientation}
            onChange={(e) => {
              userOriented.current = true
              setOrientation(e.target.value as Orientation)
            }}
            className="h-9 rounded-lg border border-white/20 bg-[#3a3d42] px-2 text-[13px] text-white outline-none focus:border-white/50 cursor-pointer"
          >
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        )}
        <span className="hidden text-[12px] text-white/60 xl:inline" data-testid="page-count">
          {thermal ? '80 mm receipt (one continuous strip)' : `${sheetPaper} ${orient}`}
          {!thermal && pages ? ` · ${pages} ${pages === 1 ? 'page' : 'pages'}` : ''}
        </span>
        {!thermal && (
          <button
            type="button"
            onClick={() => run('view')}
            disabled={!!busy || !ready}
            className="flex h-9 items-center gap-2 rounded-lg bg-white/10 px-3 font-medium hover:bg-white/20 disabled:opacity-50 cursor-pointer"
            title="Show the exact A4 pages that Print and Save PDF produce"
          >
            {busy === 'view' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Files className="h-4 w-4" />} Page view
          </button>
        )}
        <button type="button" onClick={() => run('print')} disabled={!!busy || !ready} className="flex h-9 items-center gap-2 rounded-lg bg-[#2f5bea] px-4 font-medium hover:brightness-110 disabled:opacity-50 cursor-pointer">
          {busy === 'print' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Printer className="h-4 w-4" />} Print
        </button>
        <button type="button" onClick={() => run('pdf')} disabled={!!busy || !ready} className="flex h-9 items-center gap-2 rounded-lg bg-white/10 px-4 font-medium hover:bg-white/20 disabled:opacity-50 cursor-pointer">
          {busy === 'pdf' ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileDown className="h-4 w-4" />} Save PDF
        </button>
        <button type="button" onClick={() => window.close()} className="flex h-9 w-9 items-center justify-center rounded-lg hover:bg-white/10 cursor-pointer" title="Close">
          <X className="h-5 w-5" />
        </button>
      </div>

      <div className="print:!pr-0" style={{ paddingRight: panel ? PANEL_W : 0 }}>
        {error && <div className="no-print mx-auto mb-4 max-w-[210mm] rounded-lg bg-red-100 px-4 py-3 text-red-800">{error}</div>}
        {!ctx ? (
          !error && <div className="no-print flex justify-center py-20 text-white/70"><Loader2 className="h-6 w-6 animate-spin" /></div>
        ) : Template ? (
          <Template id={Number(id)} params={params} ctx={ctx} setTitle={setTitle} {...(designable ? { design, onKind } : {})} />
        ) : (
          <div className="no-print text-center text-white">Unknown document type.</div>
        )}
      </div>

      {designable && panel && design && kt && (
        <aside
          className="no-print fixed top-14 right-0 bottom-0 z-40 flex flex-col border-l border-line bg-surface text-ink shadow-2xl"
          style={{ width: PANEL_W }}
          aria-label="Customise this print"
        >
          <div className="flex items-start justify-between gap-2 border-b border-line px-4 py-3">
            <div>
              <div className="font-semibold">Customise this print</div>
              <div className="text-[12px] leading-snug text-muted">Changes apply to this print only. The document itself is not changed.</div>
            </div>
            <button type="button" className="rounded-lg p-1 text-muted hover:bg-surface-2 cursor-pointer" title="Close panel" onClick={() => setPanel(false)}>
              <X className="h-4 w-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-4 py-4">
            <DesignControls
              dense
              layouts={builtinLayouts(kt.kind)}
              value={{ layout: design.layout, options: design.options }}
              onChange={(v: DesignValue) => setDesign({ ...design, layout: v.layout, options: v.options })}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-3">
            <Button size="sm" icon={<RotateCcw className="h-4 w-4" />} disabled={!customised} onClick={() => base && setDesign(base)}>
              Reset
            </Button>
            {can('templates.manage') && (
              <Button size="sm" variant="primary" className="ml-auto" icon={<Save className="h-4 w-4" />} onClick={() => setSaveOpen(true)}>
                Save as template
              </Button>
            )}
          </div>
        </aside>
      )}

      {saveOpen && design && kt && (
        <SaveTemplateModal
          kind={kt.kind}
          design={design}
          onClose={() => setSaveOpen(false)}
          onSaved={async (newId) => {
            setSaveOpen(false)
            await loadTemplates(kt.kind, String(newId))
          }}
        />
      )}
    </div>
  )
}

function SaveTemplateModal({ kind, design, onClose, onSaved }: { kind: TemplateKind; design: PrintDesign; onClose: () => void; onSaved: (id: number) => void }): JSX.Element {
  const thermal = design.layout === 'thermal80'
  const [name, setName] = useState(design.ref.toString().startsWith('builtin:') ? '' : `${design.name} (custom)`)
  const [forAll, setForAll] = useState(false)
  const [makeDefault, setMakeDefault] = useState(false)
  const [saving, setSaving] = useState(false)
  const save = async (): Promise<void> => {
    if (!name.trim()) return toast.error('Enter a name for the template.')
    setSaving(true)
    try {
      const newId = await api<number>('templates.save', { name: name.trim(), appliesTo: forAll && !thermal ? 'all' : kind, layout: design.layout, options: design.options })
      if (makeDefault) await api('templates.setDefault', { kind, ref: newId })
      toast.ok(`Template "${name.trim()}" saved.`)
      onSaved(newId)
    } catch (e) {
      toast.error(e)
    } finally {
      setSaving(false)
    }
  }
  return (
    <Modal
      open
      size="sm"
      onClose={onClose}
      title="Save as template"
      subtitle="Saves the current layout and options so they can be chosen for future prints."
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={save}>
            Save template
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Template name" required>
          <Input autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. Invoice with bank details" />
        </Field>
        {!thermal && <Checkbox checked={forAll} onChange={setForAll} label="Use for all document types" />}
        <Checkbox checked={makeDefault} onChange={setMakeDefault} label={`Make it the default for ${KIND_LABELS[kind].toLowerCase()}`} />
        {thermal && <div className="text-[12px] text-muted">80 mm receipt templates are saved for {KIND_LABELS[kind].toLowerCase()} only.</div>}
      </div>
    </Modal>
  )
}


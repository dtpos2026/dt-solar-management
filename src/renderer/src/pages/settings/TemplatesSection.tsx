/**
 * Settings section — Invoice / quotation template designer (owner: documents area).
 * Create / edit / duplicate / delete print templates, choose the default per document type, and see a live preview
 * rendered with a real recent document (or a clearly labelled sample when none exists yet).
 * Templates only change how documents look — never the stored document data.
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, FileText, Pencil, Plus, Star, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { useApp } from '../../store'
import { Badge, Button, Card, Field, IconButton, Input, Modal, Select, Spinner, confirmDialog, toast } from '../../components/ui'
import { DesignControls, DesignValue } from '../../print/DesignControls'
import { DocumentPrint } from '../../print/DocumentPrint'
import { PaymentPrint } from '../../print/PaymentPrint'
import type { PrintContext } from '../../print/PrintKit'
import { KIND_LABELS, LAYOUT_LABEL, Layout, SavedTemplate, TEMPLATE_KINDS, TemplateKind, THERMAL_KINDS, builtinLayouts, firmOptions, templateFits } from '../../print/design'

/* eslint-disable @typescript-eslint/no-explicit-any */
type Defaults = Partial<Record<TemplateKind, number | string>>

interface Draft {
  id?: number
  name: string
  appliesTo: TemplateKind | 'all'
  design: DesignValue
}

export function TemplatesSection(): JSX.Element {
  const [templates, setTemplates] = useState<SavedTemplate[] | null>(null)
  const [defaults, setDefaults] = useState<Defaults>({})
  const [ctx, setCtx] = useState<PrintContext | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const license = useApp((s) => s.license)

  const load = useCallback(async () => {
    try {
      const [list, defs] = await Promise.all([api<SavedTemplate[]>('templates.list', {}), api<Defaults>('templates.defaults')])
      setTemplates(list)
      setDefaults(defs)
    } catch (e) {
      toast.error(e)
    }
  }, [])

  useEffect(() => {
    void load()
    Promise.all([api<any>('firms.get', {}), api<any>('settings.get')])
      .then(([firm, settings]) => setCtx({ firm, settings, ps: firm.print_settings, poweredBy: license?.poweredBy === true }))
      .catch((e) => toast.error(e))
  }, [load, license?.poweredBy])

  const newDraft = (): void => setDraft({ name: '', appliesTo: 'all', design: { layout: 'classic', options: firmOptions(ctx?.ps) } })
  const editDraft = (t: SavedTemplate): void =>
    setDraft({ id: t.id, name: t.name, appliesTo: t.applies_to, design: { layout: t.layout, options: { ...firmOptions(undefined), ...t.options } } })

  const duplicate = async (t: SavedTemplate): Promise<void> => {
    try {
      await api('templates.duplicate', { id: t.id })
      toast.ok(`Copied “${t.name}”`)
      await load()
    } catch (e) {
      toast.error(e)
    }
  }
  const remove = async (t: SavedTemplate): Promise<void> => {
    const ok = await confirmDialog({
      title: `Delete template “${t.name}”?`,
      message: t.default_for.length
        ? `It is the default for ${t.default_for.map((k) => KIND_LABELS[k]).join(', ')}. Those documents will print with the built-in Classic layout. Documents themselves are not changed.`
        : 'Documents themselves are not changed.',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    try {
      await api('templates.delete', { id: t.id })
      toast.ok('Template deleted')
      await load()
    } catch (e) {
      toast.error(e)
    }
  }
  const setDefault = async (kind: TemplateKind, ref: string): Promise<void> => {
    try {
      await api('templates.setDefault', { kind, ref: /^\d+$/.test(ref) ? Number(ref) : ref })
      toast.ok(`Default for ${KIND_LABELS[kind]} updated`)
      await load()
    } catch (e) {
      toast.error(e)
    }
  }

  return (
    <div className="space-y-4">
      <Card
        title="Print templates"
        actions={
          <Button variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={newDraft} disabled={!ctx}>
            New template
          </Button>
        }
      >
        <p className="mb-3 text-[13px] text-muted">
          Templates decide how invoices, quotations, bills, challans, returns and receipts look when printed or saved as PDF. They never change the document data.
        </p>
        {!templates ? (
          <Spinner />
        ) : templates.length === 0 ? (
          <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-muted">
            No templates yet — documents print with the built-in layouts. Create one to choose layout, colours and what is shown.
          </div>
        ) : (
          <div className="divide-y divide-line rounded-xl border border-line" data-testid="template-list">
            {templates.map((t) => (
              <div key={t.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5">
                <span className="h-8 w-1.5 rounded-full" style={{ background: t.options.accentColor || '#0b5cad' }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-semibold">{t.name}</div>
                  <div className="text-[12px] text-muted">
                    {LAYOUT_LABEL[t.layout]} · {t.applies_to === 'all' ? 'All document types' : KIND_LABELS[t.applies_to]}
                  </div>
                </div>
                {t.default_for.map((k) => (
                  <Badge key={k} tone="info">
                    <Star className="h-3 w-3" /> {KIND_LABELS[k]}
                  </Badge>
                ))}
                <IconButton title="Edit" onClick={() => editDraft(t)}>
                  <Pencil className="h-4 w-4" />
                </IconButton>
                <IconButton title="Duplicate" onClick={() => void duplicate(t)}>
                  <Copy className="h-4 w-4" />
                </IconButton>
                <IconButton title="Delete" tone="bad" onClick={() => void remove(t)}>
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card title="Default template per document type">
        <div className="grid gap-3 sm:grid-cols-2">
          {TEMPLATE_KINDS.map((k) => {
            const cur = defaults[k] !== undefined ? String(defaults[k]) : 'builtin:classic'
            return (
              <Field key={k} label={KIND_LABELS[k]}>
                <Select value={cur} onChange={(e) => void setDefault(k, e.target.value)} data-testid={`default-${k}`}>
                  {(templates ?? [])
                    .filter((t) => templateFits(t, k))
                    .map((t) => (
                      <option key={t.id} value={String(t.id)}>
                        {t.name} — {LAYOUT_LABEL[t.layout]}
                      </option>
                    ))}
                  {builtinLayouts(k).map((l) => (
                    <option key={l} value={`builtin:${l}`}>
                      Built-in {LAYOUT_LABEL[l]}
                    </option>
                  ))}
                </Select>
              </Field>
            )
          })}
        </div>
      </Card>

      {draft && ctx && (
        <TemplateEditor
          draft={draft}
          ctx={ctx}
          onClose={() => setDraft(null)}
          onSaved={async () => {
            setDraft(null)
            await load()
          }}
        />
      )}
    </div>
  )
}

function TemplateEditor({ draft: initial, ctx, onClose, onSaved }: { draft: Draft; ctx: PrintContext; onClose: () => void; onSaved: () => void }): JSX.Element {
  const [d, setD] = useState<Draft>(initial)
  const [saving, setSaving] = useState(false)
  const [previewKind, setPreviewKind] = useState<TemplateKind>(initial.appliesTo === 'all' ? 'sale_invoice' : initial.appliesTo)
  const thermal = d.design.layout === 'thermal80'

  // Thermal receipts exist for sales invoices and payment receipts only.
  const layouts: Layout[] = d.appliesTo === 'all' ? ['classic', 'modern', 'compact', 'thermal80'] : builtinLayouts(d.appliesTo)
  const kindChoices: TemplateKind[] = d.appliesTo === 'all' ? (thermal ? THERMAL_KINDS : TEMPLATE_KINDS) : [d.appliesTo]
  useEffect(() => {
    if (!kindChoices.includes(previewKind)) setPreviewKind(kindChoices[0])
  }, [kindChoices.join(','), previewKind]) // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (): Promise<void> => {
    if (!d.name.trim()) return toast.warn('Give the template a name.')
    if (thermal && d.appliesTo !== 'all' && !THERMAL_KINDS.includes(d.appliesTo)) return toast.warn('The 80 mm receipt layout is for sales invoices and payment receipts only.')
    setSaving(true)
    try {
      await api('templates.save', { id: d.id, name: d.name.trim(), appliesTo: thermal && d.appliesTo === 'all' ? previewKind : d.appliesTo, layout: d.design.layout, options: d.design.options })
      toast.ok(d.id ? 'Template saved' : 'Template created')
      onSaved()
    } catch (e) {
      toast.error(e)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      size="full"
      onClose={onClose}
      title={d.id ? `Edit template — ${initial.name}` : 'New print template'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            Save template
          </Button>
        </>
      }
    >
      <div className="grid gap-5 lg:grid-cols-[minmax(300px,380px)_1fr]">
        <div className="space-y-4">
          <Field label="Template name" required>
            <Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. Blue invoice with bank details" autoFocus />
          </Field>
          <Field label="Applies to" hint={thermal ? 'An 80 mm receipt template is saved for the selected receipt type.' : undefined}>
            <Select value={d.appliesTo} onChange={(e) => setD({ ...d, appliesTo: e.target.value as Draft['appliesTo'] })}>
              <option value="all">All document types</option>
              {TEMPLATE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}
                </option>
              ))}
            </Select>
          </Field>
          <DesignControls layouts={layouts} value={d.design} onChange={(v) => setD({ ...d, design: v })} />
        </div>
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="text-[12px] font-semibold tracking-wide text-muted uppercase">Live preview</span>
            {kindChoices.length > 1 && (
              <Select sm className="ml-auto w-auto" value={previewKind} onChange={(e) => setPreviewKind(e.target.value as TemplateKind)} aria-label="Preview document type">
                {kindChoices.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            )}
          </div>
          <TemplatePreview kind={previewKind} ctx={ctx} design={d.design} name={d.name} />
        </div>
      </div>
    </Modal>
  )
}

/** Renders the template with the most recent real record of the kind, or a labelled sample. */
function TemplatePreview({ kind, ctx, design, name }: { kind: TemplateKind; ctx: PrintContext; design: DesignValue; name: string }): JSX.Element {
  const [src, setSrc] = useState<{ data: any; label: string; sample: boolean } | null | 'none'>(null)
  useEffect(() => {
    let live = true
    setSrc(null)
    api<{ entity: 'doc' | 'payment'; id: number; number: string } | null>('templates.previewSource', { kind })
      .then(async (s) => {
        if (!s) return kind === 'payment' ? 'none' : { data: sampleDoc(kind), label: 'SAMPLE data — no real document of this type exists yet', sample: true }
        const data = await api<any>(s.entity === 'doc' ? 'docs.get' : 'payments.get', { id: s.id })
        return { data, label: `Previewing your ${KIND_LABELS[kind].toLowerCase()} ${s.number}`, sample: false }
      })
      .then((r) => live && setSrc(r as never))
      .catch((e) => live && (toast.error(e), setSrc('none')))
    return () => {
      live = false
    }
  }, [kind])
  const pd = useMemo(() => ({ ref: 'designer', name: name || 'Template', layout: design.layout, options: design.options }), [design, name])
  if (src === null) return <Spinner />
  if (src === 'none') return <div className="rounded-xl border border-dashed border-line p-6 text-center text-muted">No payment receipt exists yet. Record a payment to preview receipt templates.</div>
  const thermal = design.layout === 'thermal80'
  const Comp = kind === 'payment' ? PaymentPrint : DocumentPrint
  return (
    <div>
      <div className={src.sample ? 'mb-2 rounded-lg bg-amber-100 px-3 py-1.5 text-[12.5px] font-semibold text-amber-900' : 'mb-2 text-[12.5px] text-muted'} data-testid="preview-source">
        <FileText className="mr-1 inline h-3.5 w-3.5" /> {src.label}
      </div>
      <div className="max-h-[70vh] overflow-auto rounded-xl bg-[#525659] p-4" data-testid="template-preview">
        <div style={{ zoom: thermal ? 0.9 : 0.62 }}>
          <Comp id={0} params={{}} ctx={ctx} setTitle={() => undefined} design={pd} data={src.data} />
        </div>
      </div>
    </div>
  )
}

function sampleDoc(kind: TemplateKind): any {
  const today = new Date().toISOString().slice(0, 10)
  const lines = [
    { id: 1, description: 'Solar Panel 585W Mono', details: 'N-type TOPCon bifacial module\n30-year linear performance warranty', brand: 'Sample Brand', model: 'SB-585', qty: 10, unit: 'pcs', rate: 28000, discount_amt: 0, tax_rate: 0, tax_amt: 0, line_total: 280000, warranty: '12 years product', serials: '' },
    { id: 2, description: 'Hybrid Inverter 6 kW', details: 'On-grid / off-grid hybrid with Wi-Fi monitoring', brand: 'Sample Brand', model: 'HV-6K', qty: 1, unit: 'pcs', rate: 210000, discount_amt: 5000, tax_rate: 0, tax_amt: 0, line_total: 205000, warranty: '5 years', serials: '' }
  ]
  return {
    doc_type: kind,
    number: 'SAMPLE-0001',
    date: today,
    status: 'final',
    party_name: 'Sample Customer',
    party_phone: '0300-0000000',
    party_address: 'Sample address',
    lines,
    subtotal: 490000,
    line_discount_total: 5000,
    doc_discount: 0,
    tax_total: 0,
    other_charges: 0,
    round_off: 0,
    grand_total: 485000,
    paid: 0,
    due: 485000,
    payments: [],
    notes: 'Sample notes',
    terms: 'Sample terms and conditions'
  }
}

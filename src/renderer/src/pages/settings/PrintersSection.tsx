/** Settings section — Printers on this computer, printer per document kind, paper size, direct printing, test print (owner: access area). */
import { ReactNode, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, FileText, Printer, Receipt, RefreshCw, RotateCcw, Save, ScrollText, Star, XCircle, Zap } from 'lucide-react'
import { api } from '../../api'
import { useApp } from '../../store'
import { Badge, Button, Card, Empty, Field, Loading, Select, Toggle, confirmDialog, cx, toast } from '../../components/ui'

/** One printer as reported by the operating system (never invented by the app). */
interface OsPrinter {
  name: string
  displayName: string
  description: string
  isDefault: boolean
  status: string | null
  location: string | null
}

type PaperSize = 'A4' | 'A5' | 'Letter' | 'Legal' | 'thermal80' | 'thermal58'

interface PrinterSettings {
  printer_default: string
  printer_invoice: string
  printer_quotation: string
  printer_report: string
  printer_receipt: string
  paper_size: PaperSize
  print_direct: boolean
}

interface ListResult {
  printers: OsPrinter[]
  settings: Partial<PrinterSettings>
  papers: PaperSize[]
  platform: string
}

interface TestResult {
  ok: boolean
  reason: string
  listed: boolean
  message: string
}

const PAPER_LABELS: Record<PaperSize, string> = {
  A4: 'A4 (210 × 297 mm)',
  A5: 'A5 (148 × 210 mm)',
  Letter: 'Letter (8.5 × 11 in)',
  Legal: 'Legal (8.5 × 14 in)',
  thermal80: 'Thermal roll 80 mm',
  thermal58: 'Thermal roll 58 mm'
}

type RoleKey = 'printer_invoice' | 'printer_quotation' | 'printer_report' | 'printer_receipt'

const ROLES: Array<{ key: RoleKey; label: string; hint: string; icon: ReactNode }> = [
  { key: 'printer_invoice', label: 'Invoices & bills', hint: 'Sale and purchase invoices, orders, challans and returns', icon: <FileText /> },
  { key: 'printer_quotation', label: 'Quotations', hint: 'Customer quotations', icon: <ScrollText /> },
  { key: 'printer_report', label: 'Reports & statements', hint: 'Reports, stock lists, party statements, project sheets', icon: <Printer /> },
  { key: 'printer_receipt', label: 'Payment receipts', hint: 'Receipts and payment vouchers — often a thermal printer', icon: <Receipt /> }
]

const EMPTY: PrinterSettings = {
  printer_default: '',
  printer_invoice: '',
  printer_quotation: '',
  printer_report: '',
  printer_receipt: '',
  paper_size: 'A4',
  print_direct: false
}

const KEYS = Object.keys(EMPTY) as Array<keyof PrinterSettings>

function normalise(s: Partial<PrinterSettings> | undefined): PrinterSettings {
  const v = { ...EMPTY, ...(s ?? {}) }
  return {
    ...v,
    printer_default: String(v.printer_default ?? ''),
    printer_invoice: String(v.printer_invoice ?? ''),
    printer_quotation: String(v.printer_quotation ?? ''),
    printer_report: String(v.printer_report ?? ''),
    printer_receipt: String(v.printer_receipt ?? ''),
    print_direct: !!v.print_direct,
    paper_size: (Object.keys(PAPER_LABELS).includes(String(v.paper_size)) ? v.paper_size : 'A4') as PaperSize
  }
}

function statusTone(status: string | null): string {
  if (!status) return 'muted'
  if (/ready|idle/i.test(status)) return 'ok'
  if (/print|warm/i.test(status)) return 'info'
  return 'bad'
}

const osName = (platform: string): string => (platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'the operating system')

export function PrintersSection(): JSX.Element {
  const canWrite = useApp((s) => s.license?.canWrite ?? false)
  const [data, setData] = useState<ListResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [orig, setOrig] = useState<PrinterSettings>(EMPTY)
  const [draft, setDraft] = useState<PrinterSettings>(EMPTY)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState<string | null>(null)
  const [results, setResults] = useState<Record<string, TestResult>>({})

  const load = async (keepDraft = false): Promise<void> => {
    setLoading(true)
    setLoadError(null)
    try {
      const r = await api<ListResult>('printers.list')
      setData(r)
      const s = normalise(r.settings)
      setOrig(s)
      if (!keepDraft) setDraft(s)
    } catch (e) {
      setLoadError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const printers = data?.printers ?? []
  const os = osName(data?.platform ?? '')
  const listed = useMemo(() => new Set(printers.map((p) => p.name)), [printers])
  const osDefault = printers.find((p) => p.isDefault) ?? null

  /** Printers saved in the settings that the OS does not list right now. */
  const missing = useMemo(() => {
    const names = new Set<string>()
    for (const k of ['printer_default', ...ROLES.map((r) => r.key)] as Array<keyof PrinterSettings>) {
      const v = String(orig[k] ?? '').trim()
      if (v && !listed.has(v)) names.add(v)
    }
    return [...names]
  }, [orig, listed])

  const changed = KEYS.filter((k) => draft[k] !== orig[k])
  const dirty = changed.length > 0
  const set = <K extends keyof PrinterSettings>(k: K, v: PrinterSettings[K]): void => setDraft((d) => ({ ...d, [k]: v }))

  const anyPrinterChosen = !!(draft.printer_default || ROLES.some((r) => draft[r.key]))

  const save = async (): Promise<void> => {
    if (!dirty) return
    const patch: Partial<PrinterSettings> = {}
    for (const k of changed) (patch as Record<string, unknown>)[k] = draft[k]
    setSaving(true)
    try {
      const next = await api<Partial<PrinterSettings>>('printers.save', { patch })
      const s = normalise(next)
      setOrig(s)
      setDraft(s)
      await useApp.getState().refresh().catch(() => undefined)
      toast.ok('Printer settings saved.')
    } catch (e) {
      toast.error(e)
    } finally {
      setSaving(false)
    }
  }

  const discard = async (): Promise<void> => {
    if (!(await confirmDialog({ title: 'Discard changes?', message: 'Your unsaved printer choices will be lost.', confirmLabel: 'Discard', danger: true }))) return
    setDraft(orig)
  }

  const test = async (name: string): Promise<void> => {
    setTesting(name)
    try {
      const r = await api<TestResult>('printers.test', { printer: name, paper: draft.paper_size })
      setResults((m) => ({ ...m, [name]: r }))
      if (r.ok) toast.ok(r.message)
      else toast.error(r.message)
    } catch (e) {
      const msg = (e as Error).message
      setResults((m) => ({ ...m, [name]: { ok: false, reason: msg, listed: listed.has(name), message: msg } }))
      toast.error(e)
    } finally {
      setTesting(null)
    }
  }

  if (loading && !data) return <Loading label="Asking the operating system for printers…" />
  if (loadError && !data) {
    return (
      <Card>
        <Empty icon={<AlertTriangle className="h-6 w-6" />} title="Could not read the printer list" action={<Button icon={<RefreshCw className="h-4 w-4" />} onClick={() => load()}>Try again</Button>}>
          {loadError}
        </Empty>
      </Card>
    )
  }

  /** Options for a printer select: OS printers, plus the saved value when the OS no longer lists it. */
  const options = (current: string): JSX.Element[] => {
    const out = printers.map((p) => (
      <option key={p.name} value={p.name}>
        {p.displayName}
        {p.isDefault ? ` (${os} default)` : ''}
        {p.status && !/ready|idle/i.test(p.status) ? ` — ${p.status}` : ''}
      </option>
    ))
    if (current && !listed.has(current)) {
      out.push(
        <option key={`missing:${current}`} value={current}>
          {current} — not found
        </option>
      )
    }
    return out
  }

  const foundBadge = (name: string): JSX.Element | null => {
    if (!name) return null
    return listed.has(name) ? null : (
      <Badge tone="bad">
        <XCircle className="h-3 w-3" /> Not found
      </Badge>
    )
  }

  const resultLine = (name: string): JSX.Element | null => {
    const r = results[name]
    if (!r) return null
    return (
      <div role="status" data-test-result={r.ok ? 'ok' : 'failed'} className={cx('mt-2 flex items-start gap-2 rounded-lg px-3 py-2 text-[12.5px]', r.ok ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad')}>
        {r.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <XCircle className="mt-0.5 h-4 w-4 shrink-0" />}
        <span className="min-w-0 break-words">{r.message}</span>
      </div>
    )
  }

  const readOnly = !canWrite

  return (
    <div className="space-y-4">
      <Card
        title={
          <span className="flex items-center gap-2">
            <Printer className="h-4 w-4 text-brand" /> Printers on this computer
          </span>
        }
        actions={
          <Button size="sm" icon={<RefreshCw className={cx('h-4 w-4', loading && 'animate-spin')} />} disabled={loading} onClick={() => load(true)}>
            Refresh
          </Button>
        }
        pad={false}
      >
        {printers.length === 0 ? (
          <Empty icon={<Printer className="h-6 w-6" />} title={`${os === 'the operating system' ? 'The operating system' : os} reports no printers on this computer`}>
            No printer is installed, or the printer service is not running. Install the printer in {os === 'Windows' ? 'Windows Settings → Bluetooth & devices → Printers & scanners' : 'the system printer settings'}, then press Refresh. You can still save documents as PDF.
          </Empty>
        ) : (
          <ul className="divide-y divide-line" data-os-printers={printers.length}>
            {printers.map((p) => (
              <li key={p.name} className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-brand-soft text-brand">
                    <Printer className="h-[18px] w-[18px]" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-semibold" title={p.name}>{p.displayName}</span>
                      {p.isDefault && (
                        <Badge tone="brand">
                          <Star className="h-3 w-3" /> {os} default
                        </Badge>
                      )}
                      <Badge tone={statusTone(p.status)}>{p.status ?? 'Status not reported'}</Badge>
                    </div>
                    <div className="truncate text-[12px] text-muted">
                      {[p.description, p.location, p.displayName !== p.name ? p.name : null].filter(Boolean).join(' · ') || 'No description reported'}
                    </div>
                  </div>
                  <Button size="sm" loading={testing === p.name} disabled={!!testing} icon={<Printer className="h-4 w-4" />} onClick={() => test(p.name)}>
                    Test print
                  </Button>
                </div>
                {resultLine(p.name)}
              </li>
            ))}
          </ul>
        )}
        {missing.length > 0 && (
          <div className="border-t border-line bg-bad-soft/40">
            <div className="px-4 pt-3 text-[12px] font-semibold tracking-wide text-bad uppercase">Saved printers that {os} does not list</div>
            <ul className="divide-y divide-line">
              {missing.map((name) => (
                <li key={name} className="px-4 py-3" data-missing-printer={name}>
                  <div className="flex items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-bad-soft text-bad">
                      <AlertTriangle className="h-[18px] w-[18px]" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="truncate font-semibold" title={name}>{name}</span>
                        <Badge tone="bad">
                          <XCircle className="h-3 w-3" /> Not found
                        </Badge>
                      </div>
                      <div className="text-[12px] text-muted">Disconnected, renamed or removed. Jobs for it open the print dialog instead.</div>
                    </div>
                    <Button size="sm" loading={testing === name} disabled={!!testing} icon={<Printer className="h-4 w-4" />} onClick={() => test(name)}>
                      Test print
                    </Button>
                  </div>
                  {resultLine(name)}
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card
        title="Which printer prints what"
        actions={
          <>
            {dirty && (
              <Button size="sm" variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={discard}>
                Discard
              </Button>
            )}
            <Button size="sm" variant="primary" icon={<Save className="h-4 w-4" />} loading={saving} disabled={!dirty || readOnly} onClick={save}>
              Save{dirty ? ` (${changed.length})` : ''}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          {readOnly && <div className="rounded-lg bg-warn-soft px-3 py-2 text-[12.5px] text-warn">The license is read-only, so printer choices cannot be changed right now. Printing still works.</div>}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <div className="rounded-xl border border-line p-3">
              <div className="mb-2 flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-soft text-brand [&>svg]:h-4 [&>svg]:w-4"><Star /></span>
                <span className="font-semibold">Default printer</span>
                {foundBadge(draft.printer_default)}
              </div>
              <Select aria-label="Default printer" value={draft.printer_default} disabled={readOnly} onChange={(e) => set('printer_default', e.target.value)}>
                <option value="">Ask every time (print dialog){osDefault ? ` — ${os} default is ${osDefault.displayName}` : ''}</option>
                {options(draft.printer_default)}
              </Select>
              <div className="mt-1.5 text-[12px] text-muted">Used for anything without its own printer below.</div>
            </div>
            {ROLES.map((r) => (
              <div key={r.key} className="rounded-xl border border-line p-3">
                <div className="mb-2 flex items-center gap-2">
                  <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-brand-soft text-brand [&>svg]:h-4 [&>svg]:w-4">{r.icon}</span>
                  <span className="font-semibold">{r.label}</span>
                  {foundBadge(draft[r.key])}
                </div>
                <Select aria-label={`${r.label} printer`} value={draft[r.key]} disabled={readOnly} onChange={(e) => set(r.key, e.target.value)}>
                  <option value="">Same as the default printer</option>
                  {options(draft[r.key])}
                </Select>
                <div className="mt-1.5 text-[12px] text-muted">{r.hint}</div>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 border-t border-line pt-4 lg:grid-cols-2">
            <Field label="Paper size" hint="Used for printing and for Save PDF. Reports always use a full sheet when a thermal roll is chosen here.">
              <Select aria-label="Paper size" value={draft.paper_size} disabled={readOnly} onChange={(e) => set('paper_size', e.target.value as PaperSize)}>
                {(data?.papers ?? (Object.keys(PAPER_LABELS) as PaperSize[])).map((p) => (
                  <option key={p} value={p}>
                    {PAPER_LABELS[p] ?? p}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="rounded-xl border border-line px-3 py-2.5">
              <Toggle
                checked={draft.print_direct}
                disabled={readOnly}
                onChange={(v) => set('print_direct', v)}
                label={
                  <span className="flex items-center gap-1.5">
                    <Zap className="h-4 w-4 text-warn" /> Print directly without the dialog
                  </span>
                }
                description={
                  draft.print_direct && !anyPrinterChosen
                    ? 'Choose a printer above — without one, the print dialog still opens.'
                    : 'Sends the job straight to the chosen printer. If that printer is not found, the print dialog opens instead.'
                }
              />
            </div>
          </div>
        </div>
      </Card>
    </div>
  )
}

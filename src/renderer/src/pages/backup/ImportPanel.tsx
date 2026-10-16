/** CSV import / export tab of the Backup page: entity picker, mapping, validation, dry run, one-transaction import (owner: data area). */
import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, FileUp, FlaskConical, History, Info, Upload } from 'lucide-react'
import { api } from '../../api'
import { Badge, Button, Card, Checkbox, Empty, Field, Select, confirmDialog, cx, toast } from '../../components/ui'
import { DataTable } from '../../components/DataTable'
import { useLoad } from '../../lib/hooks'
import { money, qty } from '../../lib/format'
import { useCan } from '../../store'
import { CsvExportCard } from './CsvExportCard'
import { CSV_KINDS, RECOMMENDED_ORDER, type CsvKind } from './csvKinds'

type Kind = CsvKind
interface ImportField {
  key: string
  label: string
  required?: boolean
  type: 'text' | 'number' | 'date' | 'bool'
}
type Mapping = Record<string, number | null>
type DateFormat = 'ymd' | 'dmy'
type DupPolicy = 'skip' | 'update'
interface RowError {
  row: number
  field?: string
  message: string
}
interface Reconciliation {
  rows: number
  valid: number
  openingQty: number
  openingValue: number
  openingBalance: number
  amount: number
}
interface ExecResult {
  imported: number
  updated: number
  skipped: number
  failed: number
  failures: RowError[]
  skippedReasons: RowError[]
  reconciliation: { matched: boolean }
}
interface Analysis {
  kind: Kind
  headers: string[]
  fields: ImportField[]
  mapping: Mapping
  preview: Array<Record<string, unknown>>
  errors: RowError[]
  warnings: RowError[]
  counts: { rows: number; records: number; create: number; update: number; skip: number; invalid: number }
  reconciliation: Reconciliation
  dryRun?: ExecResult
}
interface ImportRun {
  id: number
  kind: string
  file_name: string | null
  total_rows: number
  imported: number
  skipped: number
  errors: string | null
  reconciliation: string | null
  created_at: string
  created_by_name: string | null
}

const kindLabel = (k: Kind): string => CSV_KINDS.find((x) => x.key === k)?.label ?? k
const STATUS_TONE: Record<string, string> = { create: 'ok', update: 'info', skip: 'muted', invalid: 'bad' }
const STATUS_LABEL: Record<string, string> = { create: 'New', update: 'Update', skip: 'Skip', invalid: 'Invalid' }

/** Whole CSV tab: export (backup right) + import (import right) + the "not a full backup" note. */
export function CsvPanel(): JSX.Element {
  const can = useCan()
  return (
    <div className="space-y-4">
      <div className="flex items-start gap-2 rounded-xl border border-warn/30 bg-warn-soft px-4 py-3 text-[12.5px] text-warn">
        <Info className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          CSV files are for moving lists in and out of spreadsheets or other software. A CSV is <b>not a full backup</b>: settings, users, firms, images, projects, returns,
          stock-movement history and cancelled records are not included. Use the full backup on the Backups tab to keep or move all your data.
        </span>
      </div>
      {can('backup.manage') && <CsvExportCard />}
      {can('import.manage') && <ImportPanel />}
    </div>
  )
}

export function ImportPanel(): JSX.Element {
  const [kind, setKind] = useState<Kind>('products')
  const [file, setFile] = useState<{ fileName: string; text: string } | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [dateFormat, setDateFormat] = useState<DateFormat>('ymd')
  const [duplicates, setDuplicates] = useState<DupPolicy>('skip')
  const [skipInvalid, setSkipInvalid] = useState(false)
  const [result, setResult] = useState<(ExecResult & { runId: number }) | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const runs = useLoad(() => api<ImportRun[]>('import.runs'), [])

  const opts = (o: Partial<{ kind: Kind; mapping: Mapping; dateFormat: DateFormat; duplicates: DupPolicy; skipInvalid: boolean }> = {}): Record<string, unknown> => ({
    kind: o.kind ?? kind,
    mapping: 'mapping' in o ? o.mapping : analysis?.mapping,
    dateFormat: o.dateFormat ?? dateFormat,
    duplicates: o.duplicates ?? duplicates,
    skipInvalid: o.skipInvalid ?? skipInvalid
  })

  const analyze = async (text: string, o: Parameters<typeof opts>[0] = {}, dryRun = false): Promise<void> => {
    setBusy(dryRun ? 'dry' : 'analyze')
    try {
      setAnalysis(await api<Analysis>('import.analyze', { ...opts(o), text, dryRun }))
    } catch (e) {
      setAnalysis(null)
      toast.error(e)
    } finally {
      setBusy(null)
    }
  }

  const pick = async (): Promise<void> => {
    setBusy('pick')
    try {
      const r = await api<{ fileName: string; text: string } | null>('import.pickFile')
      if (!r) return
      setFile(r)
      setResult(null)
      await analyze(r.text, { mapping: undefined })
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy((b) => (b === 'pick' ? null : b))
    }
  }

  const changeKind = (k: Kind): void => {
    setKind(k)
    setResult(null)
    if (file) analyze(file.text, { kind: k, mapping: undefined })
  }

  const changeOpt = (o: { dateFormat?: DateFormat; duplicates?: DupPolicy; skipInvalid?: boolean }): void => {
    if (o.dateFormat) setDateFormat(o.dateFormat)
    if (o.duplicates) setDuplicates(o.duplicates)
    if (o.skipInvalid !== undefined) setSkipInvalid(o.skipInvalid)
    if (file) analyze(file.text, o)
  }

  const setMap = (field: string, col: string): void => {
    if (!file || !analysis) return
    analyze(file.text, { mapping: { ...analysis.mapping, [field]: col === '' ? null : Number(col) } })
  }

  const template = async (): Promise<void> => {
    try {
      const r = await api<{ file: string } | null>('import.template', { kind })
      if (r) toast.ok(`Template saved: ${r.file}`)
    } catch (e) {
      toast.error(e)
    }
  }

  const doImport = async (): Promise<void> => {
    if (!file || !analysis) return
    const c = analysis.counts
    const ok = await confirmDialog({
      title: `Import ${kindLabel(kind).toLowerCase()}?`,
      message: `${c.create} new and ${c.update} updated record(s) are saved together in one step; ${c.skip} duplicate(s) are skipped${
        c.invalid ? ` and ${c.invalid} invalid record(s) are left out` : ''
      }. If anything else fails, nothing is saved.`,
      confirmLabel: 'Import now'
    })
    if (!ok) return
    setBusy('run')
    try {
      const r = await api<ExecResult & { runId: number }>('import.run', { ...opts(), text: file.text, fileName: file.fileName })
      setResult(r)
      if (r.reconciliation.matched) toast.ok(`Imported ${r.imported} new, updated ${r.updated}, skipped ${r.skipped}. Totals match the file.`)
      else toast.warn(`Imported ${r.imported} new, updated ${r.updated} — the reconciliation does not match, check import run #${r.runId}.`)
      setFile(null)
      setAnalysis(null)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(null)
      runs.reload()
    }
  }

  const A = analysis
  const fieldsShown = A ? A.fields.filter((f) => A.mapping[f.key] !== null) : []
  const structural = A ? A.errors.some((e) => e.row === 0) : false
  const canRun = !!A && !structural && (A.errors.length === 0 || skipInvalid) && A.counts.create + A.counts.update > 0
  const isDocs = kind === 'sales' || kind === 'purchases' || kind === 'payments' || kind === 'expenses'
  const note = CSV_KINDS.find((k) => k.key === kind)?.importNote

  return (
    <div className="space-y-4">
      <Card title={<span className="inline-flex items-center gap-2"><FileSpreadsheet className="h-4 w-4 text-brand" /> Import from a CSV file</span>}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="What to import">
            <Select value={kind} disabled={!!busy} onChange={(e) => changeKind(e.target.value as Kind)}>
              {CSV_KINDS.map((k) => (
                <option key={k.key} value={k.key}>
                  {k.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Dates in the file">
            <Select value={dateFormat} disabled={!!busy} onChange={(e) => changeOpt({ dateFormat: e.target.value as DateFormat })}>
              <option value="ymd">yyyy-mm-dd (2026-03-31)</option>
              <option value="dmy">dd/mm/yyyy (31/03/2026)</option>
            </Select>
          </Field>
          <Field label="Already in the books">
            <Select value={duplicates} disabled={!!busy} onChange={(e) => changeOpt({ duplicates: e.target.value as DupPolicy })}>
              <option value="skip">Skip duplicates</option>
              <option value="update" disabled={isDocs || kind === 'stock'}>
                Update existing records
              </option>
            </Select>
          </Field>
          <Button variant="primary" icon={<FileUp className="h-4 w-4" />} loading={busy === 'pick'} disabled={!!busy} onClick={pick}>
            {file ? 'Choose another file…' : 'Choose CSV file…'}
          </Button>
          <Button variant="ghost" icon={<Download className="h-4 w-4" />} onClick={template}>
            Download template
          </Button>
          {file && <span className="truncate text-[12.5px] text-muted">File: {file.fileName}</span>}
        </div>
        <div className="mt-3">
          <Checkbox checked={skipInvalid} disabled={!!busy} onChange={(v) => changeOpt({ skipInvalid: v })} label="Import the valid rows and leave out the invalid ones (otherwise any problem stops the whole import)" />
        </div>
        <p className="mt-3 text-[12.5px] text-muted">
          The first row must contain column headers. Columns are matched automatically and can be changed below. Decimals use a dot; empty cells mean “no value” (on update they keep
          the existing value). Duplicates are found by SKU / name, name + phone, or document number. {note} Nothing is saved until you click “Import”. Recommended order: {RECOMMENDED_ORDER}.
        </p>
      </Card>

      {result && (
        <Card title="Last import result">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Stat label="Imported (new)" value={String(result.imported)} tone="ok" />
            <Stat label="Updated" value={String(result.updated)} />
            <Stat label="Skipped" value={String(result.skipped)} />
            <Stat label="Failed / left out" value={String(result.failed)} tone={result.failed ? 'bad' : 'ok'} />
          </div>
          <Problems title="Skipped" tone="muted" items={result.skippedReasons} />
          <Problems title="Failed" tone="bad" items={result.failures} />
        </Card>
      )}

      {A && (
        <>
          <Card title="Column mapping">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {A.fields.map((f) => (
                <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`}>
                  <Select sm value={A.mapping[f.key] === null || A.mapping[f.key] === undefined ? '' : String(A.mapping[f.key])} disabled={!!busy} onChange={(e) => setMap(f.key, e.target.value)}>
                    <option value="">— not imported —</option>
                    {A.headers.map((h, i) => (
                      <option key={i} value={i}>
                        {h || `Column ${i + 1}`}
                      </option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
          </Card>

          <Card title="Validation summary">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
              <Stat label="Rows in file" value={String(A.counts.rows)} />
              <Stat label="New" value={String(A.counts.create)} tone="ok" />
              <Stat label="Update" value={String(A.counts.update)} />
              <Stat label="Skip (duplicate)" value={String(A.counts.skip)} />
              <Stat label="Invalid" value={String(A.counts.invalid)} tone={A.counts.invalid ? 'bad' : 'ok'} />
              {kind === 'products' || kind === 'stock' ? (
                <Stat label={kind === 'stock' ? 'Counted qty' : 'Opening qty'} value={qty(A.reconciliation.openingQty)} />
              ) : kind === 'customers' || kind === 'suppliers' ? (
                <Stat label="Opening balances" value={money(A.reconciliation.openingBalance)} />
              ) : kind === 'categories' ? (
                <Stat label="Records" value={String(A.counts.records)} />
              ) : (
                <Stat label="Total amount" value={money(A.reconciliation.amount)} />
              )}
            </div>
            {A.errors.length > 0 ? (
              <Problems
                title={
                  structural
                    ? 'Fix the column mapping first.'
                    : skipInvalid
                      ? 'These rows will be left out:'
                      : 'Fix these problems in the file (or the mapping), or tick “leave out the invalid ones” — nothing is imported while any row is invalid.'
                }
                tone="bad"
                items={A.errors}
              />
            ) : (
              <div className="mt-3 flex items-center gap-2 rounded-xl bg-ok-soft px-4 py-2.5 text-[12.5px] text-ok">
                <CheckCircle2 className="h-4 w-4" /> All rows passed validation.
              </div>
            )}
            <Problems title="Warnings" tone="warn" items={A.warnings} />
            {A.dryRun && (
              <div className={cx('mt-3 rounded-xl px-4 py-3 text-[12.5px]', A.dryRun.failures.length || !A.dryRun.reconciliation.matched ? 'bg-bad-soft text-bad' : 'bg-ok-soft text-ok')}>
                <div className="font-semibold">
                  Dry run (nothing saved): {A.dryRun.imported} new, {A.dryRun.updated} updated, {A.dryRun.skipped} skipped, {A.dryRun.failed} failed —{' '}
                  {A.dryRun.reconciliation.matched ? 'totals match the file.' : 'totals do NOT match the file.'}
                </div>
                {A.dryRun.failures.length > 0 && (
                  <ul className="mt-1 list-disc space-y-0.5 pl-5">
                    {A.dryRun.failures.slice(0, 50).map((e, i) => (
                      <li key={i}>
                        Row {e.row}: {e.message}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button icon={<FlaskConical className="h-4 w-4" />} loading={busy === 'dry'} disabled={!!busy || structural} onClick={() => file && analyze(file.text, {}, true)}>
                Dry run
              </Button>
              <Button variant="primary" icon={<Upload className="h-4 w-4" />} loading={busy === 'run'} disabled={!!busy || !canRun} onClick={doImport}>
                Import {A.counts.create + A.counts.update} record(s)
              </Button>
            </div>
          </Card>

          <Card title="Preview (first 20 rows)" pad={false}>
            <DataTable<Record<string, unknown>>
              rows={A.preview}
              dense
              searchable={false}
              rowKey={(r) => Number(r.row)}
              columns={[
                { key: 'row', header: 'Row' },
                { key: '_status', header: 'Action', render: (r) => <Badge tone={STATUS_TONE[String(r._status)] ?? 'muted'}>{STATUS_LABEL[String(r._status)] ?? String(r._status)}</Badge> },
                ...fieldsShown.map((f) => ({
                  key: f.key,
                  header: f.label,
                  align: f.type === 'number' ? ('right' as const) : undefined,
                  render: (r: Record<string, unknown>) => (r[f.key] === null || r[f.key] === undefined ? <span className="text-muted">—</span> : f.type === 'bool' ? (r[f.key] ? 'Yes' : 'No') : String(r[f.key]))
                }))
              ]}
            />
          </Card>
        </>
      )}

      <Card pad={false} title={<span className="inline-flex items-center gap-2"><History className="h-4 w-4 text-brand" /> Import history</span>}>
        <DataTable<ImportRun>
          rows={runs.data ?? []}
          loading={runs.loading}
          dense
          searchable={false}
          rowKey={(r) => r.id}
          empty={<Empty icon={<FileSpreadsheet className="h-6 w-6" />} title="No imports yet" />}
          columns={[
            { key: 'created_at', header: 'Date', render: (r) => <span className="whitespace-nowrap">{r.created_at}</span> },
            { key: 'kind', header: 'Kind', render: (r) => <Badge tone="info">{r.kind}</Badge> },
            { key: 'file_name', header: 'File', render: (r) => <span className="truncate">{r.file_name ?? '—'}</span> },
            { key: 'total_rows', header: 'Rows', align: 'right' },
            { key: 'imported', header: 'Imported', align: 'right' },
            {
              key: 'result',
              header: 'Result',
              value: (r) => runResult(r).label,
              render: (r) => {
                const x = runResult(r)
                return (
                  <span title={x.detail}>
                    <Badge tone={x.tone}>{x.label}</Badge>
                  </span>
                )
              }
            },
            { key: 'created_by_name', header: 'By', render: (r) => r.created_by_name ?? '—' }
          ]}
        />
      </Card>
    </div>
  )
}

function Problems({ title, items, tone }: { title: string; items: RowError[]; tone: 'bad' | 'warn' | 'muted' }): JSX.Element | null {
  if (!items.length) return null
  return (
    <div
      className={cx(
        'mt-3 max-h-64 overflow-auto rounded-xl border px-4 py-3 text-[12.5px]',
        tone === 'bad' && 'border-bad/30 bg-bad-soft text-bad',
        tone === 'warn' && 'border-warn/30 bg-warn-soft text-warn',
        tone === 'muted' && 'border-line bg-surface-2 text-muted'
      )}
    >
      <div className="mb-1 flex items-center gap-2 font-semibold">
        <AlertTriangle className="h-4 w-4" /> {title} ({items.length})
      </div>
      <ul className="list-disc space-y-0.5 pl-5">
        {items.slice(0, 200).map((e, i) => (
          <li key={i}>
            {e.row ? `Row ${e.row}: ` : ''}
            {e.message}
          </li>
        ))}
      </ul>
    </div>
  )
}

function runResult(r: ImportRun): { label: string; tone: string; detail: string } {
  let rec: { matched?: boolean; counts?: { imported: number; updated: number; skipped: number; failed: number } } | null = null
  try {
    rec = r.reconciliation ? JSON.parse(r.reconciliation) : null
  } catch {
    rec = null
  }
  let errs: Array<{ message: string }> = []
  try {
    errs = r.errors ? JSON.parse(r.errors) : []
  } catch {
    errs = []
  }
  const c = rec?.counts
  if (r.imported === 0 && c && !c.failed && c.skipped) return { label: 'Nothing new (duplicates)', tone: 'muted', detail: `${c.skipped} skipped` }
  if (r.imported === 0) return { label: 'Failed — nothing saved', tone: 'bad', detail: errs.map((e) => e.message).slice(0, 10).join('\n') }
  if (c?.failed) return { label: `Partly imported (${c.failed} left out)`, tone: 'warn', detail: errs.map((e) => e.message).slice(0, 10).join('\n') }
  if (rec && rec.matched === false) return { label: 'Totals mismatch', tone: 'warn', detail: 'File totals differ from imported totals' }
  return { label: 'Reconciled', tone: 'ok', detail: 'File totals match imported totals' }
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'ok' | 'bad' }): JSX.Element {
  return (
    <div className="rounded-xl border border-line bg-surface-2 px-3 py-2">
      <div className="text-[11.5px] text-muted">{label}</div>
      <div className={cx('num text-[17px] font-bold', tone === 'ok' && 'text-ok', tone === 'bad' && 'text-bad')}>{value}</div>
    </div>
  )
}

/** "Import data" tab of the Backup page: CSV import with mapping, validation, dry-run reconciliation (owner: data area). */
import { useState } from 'react'
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, FileUp, History, Upload } from 'lucide-react'
import { api } from '../../api'
import { Badge, Button, Card, Empty, Field, Select, confirmDialog, cx, toast } from '../../components/ui'
import { DataTable } from '../../components/DataTable'
import { useLoad } from '../../lib/hooks'
import { money, qty } from '../../lib/format'

type Kind = 'products' | 'customers' | 'suppliers'
interface ImportField {
  key: string
  label: string
  required?: boolean
  type: 'text' | 'number'
}
type Mapping = Record<string, number | null>
interface Reconciliation {
  rows: number
  valid: number
  openingQty: number
  openingValue: number
  openingBalance: number
}
interface Analysis {
  kind: Kind
  headers: string[]
  fields: ImportField[]
  mapping: Mapping
  preview: Array<Record<string, unknown>>
  errors: Array<{ row: number; field?: string; message: string }>
  reconciliation: Reconciliation
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

const KIND_LABELS: Record<Kind, string> = { products: 'Products', customers: 'Customers', suppliers: 'Suppliers' }

export function ImportPanel(): JSX.Element {
  const [kind, setKind] = useState<Kind>('products')
  const [file, setFile] = useState<{ fileName: string; text: string } | null>(null)
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const runs = useLoad(() => api<ImportRun[]>('import.runs'), [])

  const analyze = async (text: string, k: Kind, mapping?: Mapping): Promise<void> => {
    setBusy('analyze')
    try {
      setAnalysis(await api<Analysis>('import.analyze', { kind: k, text, mapping }))
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
      await analyze(r.text, kind)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy((b) => (b === 'pick' ? null : b))
    }
  }

  const changeKind = (k: Kind): void => {
    setKind(k)
    if (file) analyze(file.text, k)
  }

  const setMap = (field: string, col: string): void => {
    if (!file || !analysis) return
    analyze(file.text, kind, { ...analysis.mapping, [field]: col === '' ? null : Number(col) })
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
    if (!file || !analysis || analysis.errors.length) return
    const rec = analysis.reconciliation
    const ok = await confirmDialog({
      title: `Import ${rec.valid} ${KIND_LABELS[kind].toLowerCase()}?`,
      message: `All ${rec.valid} rows are imported together in one step. If anything fails, nothing is saved.`,
      confirmLabel: 'Import now'
    })
    if (!ok) return
    setBusy('run')
    try {
      const r = await api<{ runId: number; imported: number; reconciliation: { matched: boolean } }>('import.run', { kind, text: file.text, mapping: analysis.mapping, fileName: file.fileName })
      if (r.reconciliation.matched) toast.ok(`Imported ${r.imported} ${KIND_LABELS[kind].toLowerCase()}. File totals match the imported totals.`)
      else toast.warn(`Imported ${r.imported} rows, but the reconciliation does not match — check import run #${r.runId}.`)
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

  return (
    <div className="space-y-4">
      <Card title={<span className="inline-flex items-center gap-2"><FileSpreadsheet className="h-4 w-4 text-brand" /> Import from a CSV file</span>}>
        <div className="flex flex-wrap items-end gap-3">
          <Field label="What to import">
            <Select value={kind} disabled={!!busy} onChange={(e) => changeKind(e.target.value as Kind)}>
              <option value="products">Products (with opening stock)</option>
              <option value="customers">Customers (with opening balance)</option>
              <option value="suppliers">Suppliers (with opening balance)</option>
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
        <p className="mt-3 text-[12.5px] text-muted">
          The first row must contain column headers. Columns are matched automatically and can be changed below. Nothing is saved until you click “Import”. Opening stock goes to the firm’s default
          warehouse as an opening-stock adjustment; opening balances are positive when the party owes you (customer) or you owe them (supplier).
        </p>
      </Card>

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

          <Card title="Dry run — reconciliation">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <Stat label="Rows in file" value={String(A.reconciliation.rows)} />
              <Stat label="Valid rows" value={String(A.reconciliation.valid)} tone={A.reconciliation.valid === A.reconciliation.rows ? 'ok' : 'bad'} />
              {kind === 'products' ? (
                <>
                  <Stat label="Opening qty" value={qty(A.reconciliation.openingQty)} />
                  <Stat label="Opening stock value" value={money(A.reconciliation.openingValue)} />
                </>
              ) : (
                <Stat label="Opening balances" value={money(A.reconciliation.openingBalance)} />
              )}
              <Stat label="Errors" value={String(A.errors.length)} tone={A.errors.length ? 'bad' : 'ok'} />
            </div>
            {A.errors.length > 0 ? (
              <div className="mt-3 max-h-64 overflow-auto rounded-xl border border-bad/30 bg-bad-soft px-4 py-3 text-[12.5px] text-bad">
                <div className="mb-1 flex items-center gap-2 font-semibold">
                  <AlertTriangle className="h-4 w-4" /> Fix these problems in the file (or the mapping) — nothing will be imported until every row is valid.
                </div>
                <ul className="list-disc space-y-0.5 pl-5">
                  {A.errors.map((e, i) => (
                    <li key={i}>
                      {e.row ? `Row ${e.row}: ` : ''}
                      {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="mt-3 flex items-center gap-2 rounded-xl bg-ok-soft px-4 py-2.5 text-[12.5px] text-ok">
                <CheckCircle2 className="h-4 w-4" /> All rows are valid and ready to import.
              </div>
            )}
            <div className="mt-4 flex justify-end">
              <Button variant="primary" icon={<Upload className="h-4 w-4" />} loading={busy === 'run'} disabled={!!busy || A.errors.length > 0 || A.reconciliation.valid === 0} onClick={doImport}>
                Import {A.reconciliation.valid} row(s)
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
                ...fieldsShown.map((f) => ({ key: f.key, header: f.label, align: f.type === 'number' ? ('right' as const) : undefined, render: (r: Record<string, unknown>) => String(r[f.key] ?? '') }))
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

function runResult(r: ImportRun): { label: string; tone: string; detail: string } {
  let rec: { matched?: boolean } | null = null
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
  if (r.imported === 0) return { label: 'Failed — nothing saved', tone: 'bad', detail: errs.map((e) => e.message).slice(0, 10).join('\n') }
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

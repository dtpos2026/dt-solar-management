/** CSV export card of the Backup page (owner: data area). Columns match the CSV import, so a file can be imported back. */
import { useState } from 'react'
import { Download, FileSpreadsheet } from 'lucide-react'
import { api } from '../../api'
import { Button, Card, Field, Select, toast } from '../../components/ui'
import { CSV_KINDS, type CsvKind } from './csvKinds'
import { DateInput } from '../../components/DateInput'

const DATED: CsvKind[] = ['sales', 'purchases', 'payments', 'expenses']

export function CsvExportCard(): JSX.Element {
  const [kind, setKind] = useState<CsvKind>('products')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [busy, setBusy] = useState(false)
  const dated = DATED.includes(kind)

  const run = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api<{ file: string; rows: number } | null>('csv.export', { kind, from: dated ? from : undefined, to: dated ? to : undefined })
      if (r) toast.ok(`Exported ${r.rows} row(s): ${r.file}`)
    } catch (e) {
      toast.error(e)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title={<span className="inline-flex items-center gap-2"><FileSpreadsheet className="h-4 w-4 text-brand" /> Export to a CSV file</span>}>
      <div className="flex flex-wrap items-end gap-3">
        <Field label="What to export">
          <Select value={kind} disabled={busy} onChange={(e) => setKind(e.target.value as CsvKind)}>
            {CSV_KINDS.map((k) => (
              <option key={k.key} value={k.key}>
                {k.label}
              </option>
            ))}
          </Select>
        </Field>
        {dated && (
          <>
            <Field label="From (optional)">
              <DateInput value={from} disabled={busy} onChange={(e) => setFrom(e.target.value)} />
            </Field>
            <Field label="To (optional)">
              <DateInput value={to} disabled={busy} onChange={(e) => setTo(e.target.value)} />
            </Field>
          </>
        )}
        <Button variant="primary" icon={<Download className="h-4 w-4" />} loading={busy} onClick={run}>
          Export CSV…
        </Button>
      </div>
      <p className="mt-3 text-[12.5px] text-muted">
        Opens in Excel (UTF-8, Urdu text kept). Dates are yyyy-mm-dd, decimals use a dot. The columns are the same as the CSV import, so the file can be imported again - into
        another firm or a new computer. {CSV_KINDS.find((k) => k.key === kind)?.exportNote}
      </p>
    </Card>
  )
}

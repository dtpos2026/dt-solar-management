/** JSON backup (.js1) export / restore and Vyapar (.vyb) conversion. */
import { useState } from 'react'
import { FileJson, FileUp, Repeat2, RotateCcw } from 'lucide-react'
import { api } from '../../api'
import { useCan } from '../../store'
import { Badge, Button, Card, Checkbox, Field, Input, Modal, toast } from '../../components/ui'

interface Inspect {
  file: string
  schemaVersion: number
  createdAt: string
  appVersion: string
  source: Record<string, unknown>
  summary: Record<string, number>
}

interface Converted {
  file: string
  report: string
  password: string
  checks: number
  failed: number
  failedChecks: string[]
  warnings: string[]
}

export function JsonBackupCard(): JSX.Element | null {
  const can = useCan()
  const [busy, setBusy] = useState<string | null>(null)
  const [inspect, setInspect] = useState<Inspect | null>(null)
  const [confirm, setConfirm] = useState('')
  const [converted, setConverted] = useState<Converted | null>(null)
  const [keepAccounts, setKeepAccounts] = useState(true)
  if (!can('backup.manage')) return null

  const run = async <T,>(key: string, fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key)
    try {
      return await fn()
    } catch (e) {
      toast.error(e)
      return undefined
    } finally {
      setBusy(null)
    }
  }

  const exportJson = (): Promise<unknown> =>
    run('export', async () => {
      const r = await api<{ file: string } | null>('jsonBackup.export')
      if (r) toast.ok(`JSON backup saved and verified: ${r.file}`)
    })

  const pick = (file?: string): Promise<unknown> =>
    run('inspect', async () => {
      const r = await api<Inspect | null>('jsonBackup.inspect', file ? { file } : {})
      if (r) {
        setConfirm('')
        setKeepAccounts(true)
        setInspect(r)
      }
    })

  const restore = (): Promise<unknown> =>
    run('restore', async () => {
      if (!inspect) return
      const r = await api<{ safety: string; carried: { owner: boolean; disabled: Array<{ username: string }> } | null }>('jsonBackup.restore', { file: inspect.file, confirm, keepAccounts })
      setInspect(null)
      const kept = r.carried?.owner ? ' Sign in with your current password.' : ' Please sign in again.'
      const waiting = r.carried?.disabled.length ? ` ${r.carried.disabled.length} user(s) limited to specific firms were switched off until you assign firms (Users & Permissions).` : ''
      toast.ok(`Backup restored. Safety copy of the previous data: ${r.safety}.${kept}${waiting}`)
      setTimeout(() => window.location.reload(), 1800)
    })

  const convert = (): Promise<unknown> =>
    run('convert', async () => {
      const r = await api<Converted | null>('legacy.convertVyapar')
      if (r) setConverted(r)
    })

  return (
    <>
      <Card title={<span className="flex items-center gap-2"><FileJson className="h-4 w-4" /> Full backup as JSON (.js1)</span>}>
        <p className="mb-3 text-[13px] text-muted">
          A complete, readable copy of all data (every table, with a checksum). Restoring rebuilds a new database, checks it and keeps a safety copy of your
          current data first. The normal .dtbak backup above remains the everyday backup; both restore the same data.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button icon={<FileJson className="h-4 w-4" />} loading={busy === 'export'} onClick={exportJson}>Export JSON backup</Button>
          {can('backup.manage') && <Button icon={<RotateCcw className="h-4 w-4" />} loading={busy === 'inspect'} onClick={() => pick()}>Restore JSON backup…</Button>}
        </div>
      </Card>

      {can('import.manage') && (
        <Card title={<span className="flex items-center gap-2"><Repeat2 className="h-4 w-4" /> Import from Vyapar (.vyb)</span>}>
          <p className="mb-3 text-[13px] text-muted">
            Converts a Vyapar backup into a DT Solar Pro JSON backup with a reconciliation report (record counts, totals, party balances, bill
            outstanding, cash / bank balances, stock). Your current data is not changed until you choose to restore the converted file.
          </p>
          <Button variant="primary" icon={<FileUp className="h-4 w-4" />} loading={busy === 'convert'} onClick={convert}>Convert a Vyapar backup…</Button>
          {converted && (
            <div className="mt-4 space-y-2 rounded-xl border border-line p-3 text-[13px]">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={converted.failed ? 'bad' : 'ok'}>{converted.failed ? `${converted.failed} check(s) failed` : `All ${converted.checks} checks passed`}</Badge>
                <span className="break-all text-muted">{converted.file}</span>
              </div>
              {converted.failedChecks.length > 0 && <ul className="list-disc pl-5 text-bad">{converted.failedChecks.map((x) => <li key={x}>{x}</li>)}</ul>}
              {converted.warnings.length > 0 && <ul className="list-disc pl-5 text-warn">{converted.warnings.map((x) => <li key={x}>{x}</li>)}</ul>}
              <div>
                When you restore it here, your own users, passwords and settings on this computer are kept, so you sign in with your current password. Only on a computer without an owner (or if you untick
                that option) sign in as <b>admin</b> with the temporary password <b className="font-mono">{converted.password}</b> (you will be asked to change it).
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" onClick={() => api('legacy.openReport', { file: converted.report }).catch(toast.error)}>Open report</Button>
                <Button size="sm" variant="primary" disabled={converted.failed > 0} onClick={() => pick(converted.file)}>Restore this converted backup…</Button>
              </div>
            </div>
          )}
        </Card>
      )}

      <Modal
        open={!!inspect}
        onClose={() => setInspect(null)}
        title="Restore JSON backup"
        subtitle={inspect?.file}
        footer={
          <>
            <Button onClick={() => setInspect(null)}>Cancel</Button>
            <Button variant="danger" loading={busy === 'restore'} disabled={confirm !== 'RESTORE'} onClick={restore}>Replace my data with this backup</Button>
          </>
        }
      >
        {inspect && (
          <div className="space-y-3 text-[13px]">
            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
              <span className="text-muted">Created</span><span>{new Date(inspect.createdAt).toLocaleString()}</span>
              <span className="text-muted">Source</span><span>{String(inspect.source?.kind ?? 'export')}{inspect.source?.file ? ` - ${String(inspect.source.file)}` : ''}</span>
              {Object.entries(inspect.summary).map(([k, v]) => (
                <span key={k} className="contents"><span className="text-muted capitalize">{k}</span><span className="num">{v}</span></span>
              ))}
            </div>
            <div className="rounded-lg bg-warn-soft p-3 text-warn">
              All current data on this computer will be replaced by this backup. A safety copy of the current data is saved first.
            </div>
            {inspect.source?.kind === 'vyapar-conversion' && (
              <div className="rounded-lg border border-line p-3">
                <Checkbox
                  checked={keepAccounts}
                  onChange={setKeepAccounts}
                  label={<span className="font-medium">Keep my current users, passwords and settings (recommended)</span>}
                />
                <p className="mt-1 text-muted">
                  The converted file has no password of yours. With this on, you stay the owner with your existing password (copied as it is, never shown or reset), the other users keep theirs, and backup,
                  printer and lock settings of this computer stay. Automatic backup keeps running without asking for a password.
                </p>
              </div>
            )}
            <Field label='Type RESTORE to confirm'>
              <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="RESTORE" />
            </Field>
          </div>
        )}
      </Modal>
    </>
  )
}

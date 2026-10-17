import { useState } from 'react'
import { Eraser } from 'lucide-react'
import { ConfirmDialog, type ConfirmOptions } from '../pages/licensing/kit'
import { planClearAllActivity, runClearAllActivity } from '../lib/clearing'
import { errorMessage } from '../lib/format'

/**
 * "Clear all" for the activity log and the dashboard's recent activity: counts the entries first, asks to confirm the exact
 * number, then deletes them in batches. Security entries (the protected audit trail) and every client, license, device and
 * invoice record are kept; one security entry records who cleared what.
 */
export function ClearAllActivityButton({ onCleared, className }: { onCleared?: (n: number) => void; className?: string }) {
  const [counting, setCounting] = useState(false)
  const [opts, setOpts] = useState<ConfirmOptions | null>(null)
  const [error, setError] = useState<string | null>(null)

  const start = async () => {
    setError(null)
    setCounting(true)
    try {
      const plan = await planClearAllActivity()
      const n = plan.refs.length
      const m = plan.archiveRefs?.length ?? 0
      if (n + m === 0) {
        setError('The activity log is already empty.')
        return
      }
      setOpts({
        title: 'Clear all activity',
        confirmLabel: `Clear ${n + m} entr${n + m === 1 ? 'y' : 'ies'}`,
        tone: 'danger',
        typeToConfirm: n + m > 50 ? 'CLEAR' : undefined,
        body: (
          <div className="space-y-2">
            <p>
              <b>{n}</b> activity entr{n === 1 ? 'y' : 'ies'} will be deleted and <b>{m}</b> security entr{m === 1 ? 'y' : 'ies'} (sign-ins, permission changes) will be archived. All of them leave the dashboard, its counts and the Activity Log.
              Clients, licenses, devices, invoices and support chats are not touched.
            </p>
            <p className="text-[13px] text-[#6b5d85]">Archived security entries stay in the database as the protected audit trail and can be shown again with Show archived. This clean-up is recorded.</p>
          </div>
        ),
        run: async () => {
          const done = await runClearAllActivity(plan)
          onCleared?.(done)
        }
      })
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setCounting(false)
    }
  }

  return (
    <>
      <button className={className ?? 'btn btn-secondary btn-sm text-red-700'} onClick={start} disabled={counting} title="Delete all activity entries (security records are kept)">
        <Eraser className="h-4 w-4" />{counting ? 'Counting…' : 'Clear all'}
      </button>
      {error && <span role="alert" className="text-[12px] text-red-700">{error}</span>}
      <ConfirmDialog opts={opts} onClose={() => setOpts(null)} />
    </>
  )
}

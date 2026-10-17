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
      if (n === 0) {
        setError(plan.kept ? `Nothing to clear: the ${plan.kept} remaining entr${plan.kept === 1 ? 'y is a' : 'ies are'} protected security record${plan.kept === 1 ? '' : 's'}.` : 'The activity log is already empty.')
        return
      }
      setOpts({
        title: 'Clear all activity',
        confirmLabel: `Delete ${n} entr${n === 1 ? 'y' : 'ies'}`,
        tone: 'danger',
        typeToConfirm: n > 50 ? 'CLEAR' : undefined,
        body: (
          <div className="space-y-2">
            <p>
              <b>{n}</b> activity entr{n === 1 ? 'y' : 'ies'} will be deleted from the activity log and the dashboard. Clients, licenses, devices, invoices and support chats are not touched.
            </p>
            <p className="text-[12.5px] text-[#6b5d85]">Security entries ({plan.kept} kept) are the protected audit trail; this clean-up is recorded there.</p>
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

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Project delete / archive / restore / cancel flows (list + detail page).
 * The main process refuses to delete a project with any linked record; this dialog explains why and offers
 * Archive (hide, keep everything) or Cancel status instead. Financial records are never deleted.
 */
import { useEffect, useState } from 'react'
import { Archive, Ban, Trash2 } from 'lucide-react'
import { api } from '../../api'
import { useCan } from '../../store'
import { Button, Loading, Modal, confirmDialog, promptDialog, toast } from '../../components/ui'

export interface ProjectLinks {
  id: number
  code: string
  name: string
  status: string
  is_archived: number
  total: number
  summary: string[]
}

export type ProjectChange = 'deleted' | 'archived' | 'restored' | 'cancelled'

export async function archiveProjectFlow(p: { id: number; code: string; name: string }): Promise<boolean> {
  const ok = await confirmDialog({
    title: `Archive project ${p.code}?`,
    message: 'The project is hidden from the project list and from pickers on new invoices, payments and expenses. All its invoices, payments, expenses, materials and files stay exactly as they are and still count in reports. You can restore it at any time.',
    confirmLabel: 'Archive project'
  })
  if (!ok) return false
  try {
    await api('projects.archive', { id: p.id })
    toast.ok(`Project ${p.code} archived.`)
    return true
  } catch (e) {
    toast.error(e)
    return false
  }
}

export async function restoreProjectFlow(p: { id: number; code: string }): Promise<boolean> {
  try {
    await api('projects.restore', { id: p.id })
    toast.ok(`Project ${p.code} restored.`)
    return true
  } catch (e) {
    toast.error(e)
    return false
  }
}

export async function cancelProjectFlow(p: { id: number; code: string; name: string }): Promise<boolean> {
  const reason = await promptDialog({
    title: `Mark project ${p.code} as cancelled?`,
    message: 'The project keeps all its records but is marked Cancelled: it no longer appears in pickers and no new materials can be issued to it.',
    confirmLabel: 'Mark as cancelled',
    danger: true,
    input: { label: 'Reason (optional)', placeholder: 'e.g. Customer withdrew' }
  })
  if (reason === null) return false
  try {
    await api('projects.cancel', { id: p.id, reason: reason || undefined })
    toast.ok(`Project ${p.code} marked as cancelled.`)
    return true
  } catch (e) {
    toast.error(e)
    return false
  }
}

/** Delete dialog: permanent delete when nothing is linked, otherwise explains and offers Archive / Cancel. */
export function ProjectDeleteDialog({ project, onClose, onDone }: { project: { id: number } | null; onClose: () => void; onDone: (change: ProjectChange) => void }): JSX.Element {
  const can = useCan()
  const [links, setLinks] = useState<ProjectLinks | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setLinks(null)
    if (!project) return
    api<ProjectLinks>('projects.links', { id: project.id })
      .then(setLinks)
      .catch((e) => {
        toast.error(e)
        onClose()
      })
  }, [project]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (fn: () => Promise<boolean>, change: ProjectChange): Promise<void> => {
    setBusy(true)
    try {
      if (await fn()) {
        onClose()
        onDone(change)
      }
    } finally {
      setBusy(false)
    }
  }
  const del = (): Promise<void> =>
    run(async () => {
      try {
        await api('projects.delete', { id: links!.id })
        toast.ok(`Project ${links!.code} deleted.`)
        return true
      } catch (e) {
        toast.error(e)
        return false
      }
    }, 'deleted')

  const hasRecords = !!links && links.total > 0
  const canArchive = can('projects.delete') && !!links && !links.is_archived
  const canCancel = can('projects.manage') && !!links && links.status !== 'cancelled' && links.status !== 'completed'
  return (
    <Modal
      open={!!project}
      onClose={onClose}
      size="sm"
      title={!links ? 'Delete project' : hasRecords ? `Project ${links.code} cannot be deleted` : `Delete project ${links.code}?`}
      subtitle={links?.name}
      footer={
        !links ? undefined : hasRecords ? (
          <>
            <Button onClick={onClose}>Close</Button>
            {canCancel && (
              <Button icon={<Ban className="h-4 w-4" />} disabled={busy} onClick={() => run(() => cancelProjectFlow(links), 'cancelled')}>
                Mark as cancelled
              </Button>
            )}
            {canArchive && (
              <Button variant="primary" icon={<Archive className="h-4 w-4" />} loading={busy} onClick={() => run(() => archiveProjectFlow(links), 'archived')}>
                Archive project
              </Button>
            )}
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="danger" icon={<Trash2 className="h-4 w-4" />} loading={busy} onClick={del}>
              Delete permanently
            </Button>
          </>
        )
      }
    >
      {!links ? (
        <Loading label="Checking linked records…" />
      ) : hasRecords ? (
        <div className="space-y-3 text-[13.5px]">
          <p className="text-muted">This project is linked to:</p>
          <ul className="list-disc space-y-0.5 pl-5">
            {links.summary.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <p className="text-muted">
            Invoices, payments, expenses and stock records are never deleted together with a project, so your accounts stay correct.
            {canArchive && ' Archive it to hide it from lists and pickers while keeping everything.'}
            {canCancel && ' If the job will not go ahead, mark it as cancelled.'}
            {links.is_archived ? ' It is already archived.' : ''}
          </p>
        </div>
      ) : (
        <p className="text-[13.5px] text-muted">
          This project has no quotations, invoices, purchases, payments, expenses, material issues, balance adjustments or attached files. It will be removed
          permanently. This cannot be undone.
        </p>
      )}
    </Modal>
  )
}

/** Settings, Software version: what Digital Target publishes as the latest and the minimum supported version of DT Solar Pro. */
import { useEffect, useState } from 'react'
import { Download } from 'lucide-react'
import { useAdminEmail, useCan } from '../lib/auth'
import { errorMessage } from '../lib/format'
import { EMPTY_VERSION, validateVersion, type PublishedVersion } from '../lib/version'
import { savePublishedVersion, usePublishedVersion } from '../lib/versionStore'
import { Loading, Notice, type NoticeMsg } from './licensing/kit'

export function VersionPanel() {
  const can = useCan()
  const by = useAdminEmail()
  const canEdit = can('branding.manage')
  const published = usePublishedVersion()
  const [f, setF] = useState<PublishedVersion>(EMPTY_VERSION)
  const [loaded, setLoaded] = useState(false)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<NoticeMsg | null>(null)

  useEffect(() => {
    if (!published.loading && !loaded) {
      setF(published.value)
      setLoaded(true)
    }
  }, [published.loading, published.value, loaded])

  if (!loaded) return <div className="card"><Loading label="Loading version…" /></div>
  const err = validateVersion(f)
  const dirty = JSON.stringify(f) !== JSON.stringify(published.value)
  const save = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await savePublishedVersion(f, by)
      published.reload()
      setMsg({ tone: 'success', text: 'Published. Computers read it within hours and show an update notice; the Devices page marks the computers that run an older version.' })
    } catch (e) {
      setMsg({ tone: 'error', text: errorMessage(e) })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="card p-5">
      <div className="mb-1 flex items-center gap-2 text-[16px] font-bold"><Download className="h-5 w-5 text-[#7c3aed]" />Software version</div>
      <p className="mb-4 max-w-2xl text-[13.5px] text-[#6b5d85]">
        Each computer reports the version it really runs. Here you publish the newest version that is available and, optionally, the lowest version that is still supported.
        Computers show Installed version and Available version separately.
      </p>
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <fieldset disabled={!canEdit || busy} className="grid max-w-2xl gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="label">Latest available version</span>
          <input className="input" value={f.latest} placeholder="1.5.0" onChange={(e) => setF({ ...f, latest: e.target.value })} />
        </label>
        <label className="block">
          <span className="label">Lowest supported version</span>
          <input className="input" value={f.minimum} placeholder="Optional, for example 1.4.0" onChange={(e) => setF({ ...f, minimum: e.target.value })} />
          <span className="mt-1 block text-[12.5px] text-[#7a6d92]">Computers below it are shown an update-required notice.</span>
        </label>
        <label className="block sm:col-span-2">
          <span className="label">Download link</span>
          <input className="input" value={f.url} placeholder="https://" onChange={(e) => setF({ ...f, url: e.target.value })} />
        </label>
        <label className="block sm:col-span-2">
          <span className="label">What is new (shown to customers)</span>
          <textarea className="input" rows={3} maxLength={500} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </label>
      </fieldset>
      {dirty && err && <div className="mt-3 text-[13px] text-red-700">{err}</div>}
      {canEdit ? (
        <div className="mt-4"><button className="btn btn-primary" disabled={busy || !dirty || !!err} onClick={save}>{busy ? 'Publishing…' : 'Publish version'}</button></div>
      ) : (
        <div className="mt-4 text-[13px] text-[#7a6d92]">You can view the published version. Changing it needs the branding permission.</div>
      )}
    </div>
  )
}

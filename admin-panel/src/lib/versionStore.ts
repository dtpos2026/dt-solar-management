import { doc, getDoc, serverTimestamp, setDoc } from 'firebase/firestore'
import { db } from '../firebase'
import { logActivity } from './audit'
import { useCachedValue } from './liveData'
import { invalidate } from './queryCache'
import { EMPTY_VERSION, type PublishedVersion, validateVersion } from './version'

export const VERSION_KEY = 'publicSettings:version'
const ref = () => doc(db, 'publicSettings', 'version')

export async function loadPublishedVersion(): Promise<PublishedVersion> {
  const s = await getDoc(ref())
  const d = s.exists() ? s.data() : {}
  const str = (v: unknown) => (typeof v === 'string' ? v : '')
  return { latest: str(d.latest), minimum: str(d.minimum), notes: str(d.notes), url: str(d.url) }
}

/** The version the Super Admin published (cached, shared by the Devices page and the Settings panel). */
export function usePublishedVersion(enabled = true) {
  return useCachedValue<PublishedVersion>(VERSION_KEY, loadPublishedVersion, EMPTY_VERSION, enabled, 5 * 60_000)
}

export async function savePublishedVersion(v: PublishedVersion, by: string): Promise<void> {
  const err = validateVersion(v)
  if (err) throw new Error(err)
  const clean = { latest: v.latest.trim(), minimum: v.minimum.trim(), notes: v.notes.trim(), url: v.url.trim() }
  await setDoc(ref(), { ...clean, updatedAt: serverTimestamp(), updatedBy: by })
  await logActivity({ action: 'version_published', category: 'settings', target: clean.latest, targetType: 'software_version', details: `Latest version ${clean.latest}${clean.minimum ? `, minimum ${clean.minimum}` : ''}` })
  invalidate(VERSION_KEY)
}

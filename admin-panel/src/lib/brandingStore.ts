/**
 * Firestore access for Digital Target branding and portal settings.
 *   settings/branding        — full Branding (admins read, branding.manage writes)
 *   publicSettings/branding  — public subset (public get; used by the invoice verification page)
 *   settings/portal          — { sessionTimeoutMin } (admins read, branding.manage writes)
 */
import { useEffect, useState } from 'react'
import { Timestamp, doc, getDoc, onSnapshot, serverTimestamp, writeBatch } from 'firebase/firestore'
import { auth, db } from '../firebase'
import { writeActivity } from './audit'
import { changedBrandingFields, clampSessionTimeout, cleanBranding, normaliseBranding, publicBranding, DEFAULT_SESSION_TIMEOUT_MIN } from './branding'
import { errorMessage } from './format'
import { DEFAULT_BRANDING, type Branding } from './types'

export const brandingRef = () => doc(db, 'settings', 'branding')
export const publicBrandingRef = () => doc(db, 'publicSettings', 'branding')
export const portalSettingsRef = () => doc(db, 'settings', 'portal')

/** One-off read with DEFAULT_BRANDING fallback (never throws). */
export async function loadBranding(): Promise<Branding> {
  try {
    const s = await getDoc(brandingRef())
    return normaliseBranding(s.exists() ? s.data() : null)
  } catch {
    return { ...DEFAULT_BRANDING }
  }
}

export async function loadSessionTimeoutMin(): Promise<number> {
  try {
    const s = await getDoc(portalSettingsRef())
    return s.exists() ? clampSessionTimeout(s.data().sessionTimeoutMin) : DEFAULT_SESSION_TIMEOUT_MIN
  } catch {
    return DEFAULT_SESSION_TIMEOUT_MIN
  }
}

export interface SettingsState {
  loading: boolean
  error: string | null
  /** False until settings/branding has been saved once (defaults are shown). */
  saved: boolean
  branding: Branding
  sessionTimeoutMin: number
  updatedAt: Timestamp | null
  updatedBy: string
}

/** Live settings for the Settings page. */
export function useSettingsDocs(): SettingsState {
  const [st, setSt] = useState<SettingsState>({
    loading: true,
    error: null,
    saved: false,
    branding: { ...DEFAULT_BRANDING },
    sessionTimeoutMin: DEFAULT_SESSION_TIMEOUT_MIN,
    updatedAt: null,
    updatedBy: ''
  })
  useEffect(() => {
    let gotBranding = false
    let gotPortal = false
    const done = () => gotBranding && gotPortal
    const a = onSnapshot(
      brandingRef(),
      (s) => {
        gotBranding = true
        const d = s.exists() ? s.data() : null
        setSt((x) => ({
          ...x,
          loading: !done(),
          saved: s.exists(),
          branding: normaliseBranding(d),
          updatedAt: d?.updatedAt instanceof Timestamp ? d.updatedAt : null,
          updatedBy: typeof d?.updatedBy === 'string' ? d.updatedBy : ''
        }))
      },
      (e) => setSt((x) => ({ ...x, loading: false, error: errorMessage(e) }))
    )
    const b = onSnapshot(
      portalSettingsRef(),
      (s) => {
        gotPortal = true
        setSt((x) => ({ ...x, loading: !done(), sessionTimeoutMin: s.exists() ? clampSessionTimeout(s.data().sessionTimeoutMin) : DEFAULT_SESSION_TIMEOUT_MIN }))
      },
      (e) => setSt((x) => ({ ...x, loading: false, error: errorMessage(e) }))
    )
    return () => {
      a()
      b()
    }
  }, [])
  return st
}

/**
 * Saves branding (private + public copy) and the session timeout in one batch with an activity entry.
 * Merge writes keep fields other areas may add to settings/branding.
 */
export async function saveSettings(prev: Branding, next: Branding, prevTimeout: number, nextTimeout: number): Promise<string[]> {
  const clean = cleanBranding(next)
  const changed = changedBrandingFields(prev, clean)
  const timeout = clampSessionTimeout(nextTimeout)
  const timeoutChanged = timeout !== prevTimeout
  const by = auth.currentUser?.email ?? ''
  const batch = writeBatch(db)
  batch.set(brandingRef(), { ...clean, updatedAt: serverTimestamp(), updatedBy: by }, { merge: true })
  batch.set(publicBrandingRef(), { ...publicBranding(clean), updatedAt: serverTimestamp() }, { merge: true })
  batch.set(portalSettingsRef(), { sessionTimeoutMin: timeout, updatedAt: serverTimestamp(), updatedBy: by }, { merge: true })
  const fields = [...changed, ...(timeoutChanged ? ['sessionTimeoutMin'] : [])]
  const imageNote = (k: 'logo' | 'signature' | 'paymentQr') => (changed.includes(k) ? `${k} ${clean[k] ? 'updated' : 'removed'}` : null)
  const textChanges = changed
    .filter((k) => !['logo', 'signature', 'paymentQr'].includes(k))
    .map((k) => `${k}: ${short(prev[k])} → ${short(clean[k])}`)
  writeActivity(batch, {
    action: 'settings_updated',
    category: 'settings',
    target: 'settings/branding',
    targetType: 'settings',
    details: fields.length
      ? [...textChanges, imageNote('logo'), imageNote('signature'), imageNote('paymentQr'), timeoutChanged ? `session timeout: ${prevTimeout} → ${timeout} min` : null]
          .filter(Boolean)
          .join('; ')
      : 'Saved without changes',
    meta: { fields }
  })
  await batch.commit()
  return fields
}

function short(v: unknown): string {
  const t = v === null || v === undefined ? '—' : String(v)
  return t.length > 60 ? `${t.slice(0, 57)}…` : t || '—'
}

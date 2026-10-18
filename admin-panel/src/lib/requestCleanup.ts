/**
 * Closes activation requests that need nothing more: the computer already holds an active slot on the license (it activated
 * itself instantly, or an administrator approved it). Without this a request stayed "pending" in the queue, the Dashboard and
 * Devices until someone opened the Requests page. A request from an installer built with a different signing key is never
 * closed: that computer cannot verify anything signed here, so it must stay visible with its mismatch.
 */
import { onSnapshot, query, serverTimestamp, updateDoc, where } from 'firebase/firestore'
import { satisfiedRequests } from './requestCleanupLogic'
import { requestFromSnap, requestRef, requestsCol } from './licenses'
import type { ActivationRequest, License } from './types'

/** Live: keeps the pending queue clean for as long as it runs. Returns the unsubscribe function. */
export function watchSatisfiedRequests(getLicenses: () => License[], getFingerprint: () => string | undefined, by: string): () => void {
  const closed = new Set<string>()
  let latest: ActivationRequest[] = []
  const run = (): void => {
    for (const { request, license } of satisfiedRequests(latest, getLicenses(), getFingerprint())) {
      if (closed.has(request.id)) continue
      closed.add(request.id)
      void updateDoc(requestRef(request.id), { status: 'processed', message: 'Activated instantly (valid key, free device slot).', licenseId: license.id, processedAt: serverTimestamp(), processedBy: by }).catch(() => closed.delete(request.id))
    }
  }
  const unsub = onSnapshot(
    query(requestsCol(), where('status', '==', 'pending')),
    (s) => {
      latest = s.docs.map(requestFromSnap)
      run()
    },
    () => undefined
  )
  const timer = setInterval(run, 20_000) // licenses change without the request list changing
  return () => {
    unsub()
    clearInterval(timer)
  }
}

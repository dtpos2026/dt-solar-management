import { useEffect, useRef } from 'react'
import { useAdminEmail, useCan } from '../lib/auth'
import { syncPasses } from '../lib/activationPass'
import { useSharedLicenses } from '../lib/liveData'
import { useSigningKey } from '../lib/signingKey'
import { watchSatisfiedRequests } from '../lib/requestCleanup'

/**
 * Keeps every license's activation pass signed and current while the signing key is loaded (see lib/activationPass).
 * Also closes activation requests that are already satisfied. Renders nothing; reuses the shared license listener.
 */
export function PassSync(): null {
  const { key } = useSigningKey()
  const can = useCan()
  const by = useAdminEmail()
  const allowed = can('licenses.manage') || can('licenses.generate')
  const { data } = useSharedLicenses(!!key && allowed)
  useEffect(() => {
    if (!key || !allowed || data.length === 0) return
    void syncPasses(data, key, by)
  }, [key, allowed, data, by])

  // Requests of computers that already hold an active slot are closed wherever the administrator is, not only on the Requests page.
  const canRequests = can('devices.manage') || can('licenses.manage')
  const latest = useRef({ data, fingerprint: key?.fingerprint })
  latest.current = { data, fingerprint: key?.fingerprint }
  useEffect(() => {
    if (!canRequests || !allowed) return
    return watchSatisfiedRequests(() => latest.current.data, () => latest.current.fingerprint, by)
  }, [canRequests, allowed, by])
  return null
}

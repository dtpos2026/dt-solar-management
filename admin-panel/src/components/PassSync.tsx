import { useEffect } from 'react'
import { useAdminEmail, useCan } from '../lib/auth'
import { syncPasses } from '../lib/activationPass'
import { useSharedLicenses } from '../lib/liveData'
import { useSigningKey } from '../lib/signingKey'

/**
 * Keeps every license's activation pass signed and current while the signing key is loaded (see lib/activationPass).
 * Renders nothing; reuses the shared license listener, so it adds no reads of its own.
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
  return null
}

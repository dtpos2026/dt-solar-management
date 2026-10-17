/**
 * Full block: when Digital Target suspended / revoked / deactivated this installation, or the license expired or can no longer
 * be verified, the application does not open its modules at all (main process: every protected route is refused; screen:
 * LicenseBlockedScreen). An installation that was never activated (old local-trial installs) stays read-only so the owner can
 * still reach Settings > License to activate. Shared by the main process and the renderer.
 */
export function isFullyBlocked(st: { canWrite: boolean; mode: string } | null | undefined): boolean {
  return !!st && !st.canWrite && st.mode !== 'not_activated'
}

/** Routes that still work while blocked: the status screen, contacting Digital Target and taking a backup of one's own data. */
const ALLOWED = new Set([
  'app.info',
  'app.activity',
  'app.openExternal',
  'auth.me',
  'auth.logout',
  'auth.lock',
  'auth.unlock',
  'auth.changePassword',
  'help.info',
  'jsonBackup.export',
  'backup.export',
  'backup.create',
  'backup.info'
])

export function blockedAllows(method: string): boolean {
  return ALLOWED.has(method) || method.startsWith('license.') || method.startsWith('support.')
}

export const BLOCK_TITLE: Record<string, string> = {
  suspended: 'License suspended',
  revoked: 'License revoked',
  device_deactivated: 'This computer is deactivated',
  expired: 'License expired',
  trial_expired: 'Trial ended',
  lease_expired: 'License verification required',
  clock_error: 'Computer date and time problem',
  invalid: 'License problem'
}

/** Connects the CloudService to the running app (database, session, license) and runs its background timers. */
import { Notification } from 'electron'
import { runtime } from '../runtime'
import { log } from '../log'
import { CloudService } from './service'

let cloud: CloudService | null = null

/**
 * Timers run in installed (packaged) builds. Development / test runs of the unpackaged app do not write heartbeats to
 * the production project on their own — unless they point at the emulator or opt in with DTSP_CLOUD_BACKGROUND=1.
 * Customer-initiated actions (Send now, support messages, activation) always work.
 */
function backgroundAllowed(): boolean {
  if (process.env.DTSP_CLOUD_BACKGROUND === '1') return true
  if (process.env.DTSP_CLOUD_BACKGROUND === '0') return false
  return !runtime.isDev || !!process.env.DTSP_FIRESTORE_EMULATOR
}

/** The installation's cloud service (created on first use, after the license service exists). */
export function getCloud(): CloudService {
  if (cloud) return cloud
  const license = runtime.license
  if (!license) throw new Error('License service is not ready.')
  cloud = new CloudService({
    dir: runtime.paths.licenseDir,
    license,
    getDb: () => runtime.db,
    getSession: () => (runtime.session ? { firmId: runtime.session.firmId, fullName: runtime.session.user.fullName } : null),
    log,
    background: backgroundAllowed(),
    onIncoming: (msgs) => {
      try {
        if (!Notification.isSupported()) return
        const n = new Notification({
          title: msgs.length === 1 ? 'Digital Target replied' : `${msgs.length} new replies from Digital Target`,
          body: `${msgs[msgs.length - 1].body.slice(0, 140)}\nOpen Settings → Support messages to read.`
        })
        n.show()
      } catch {
        /* notifications are optional */
      }
    }
  })
  return cloud
}

/** Starts heartbeats (shortly after the window is ready, then every 15 minutes) and background support sync. */
export function startCloudJobs(): void {
  try {
    getCloud().start()
  } catch (e) {
    log('warn', `Online features not started: ${(e as Error).message}`)
  }
}

export function stopCloudJobs(): void {
  cloud?.stop()
}

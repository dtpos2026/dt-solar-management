import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import publicKeyPem from '../../resources/license-public.pem?raw'
import { runtime } from './runtime'
import { openAppDatabase, closeDatabase } from './database'
import { LicenseService } from './license/service'
import { dispatch } from './ipc/router'
import { broadcast, createMainWindow, createSplash, getMainWindow, isTrustedSender } from './windows'
import { autoBackupIfDue } from './backup'
import { initLog, log } from './log'
import { AppError } from './services/context'

const SPLASH_MIN_MS = 3200
/** Firebase Cloud Function that issues / renews license certificates (Digital Target project). Override with MAIN_VITE_LICENSE_API_URL. */
const DEFAULT_LICENSE_API_URL = 'https://us-central1-dt-soalr-mangement.cloudfunctions.net/licenseApi'
const LICENSE_API_URL = (import.meta.env.MAIN_VITE_LICENSE_API_URL || DEFAULT_LICENSE_API_URL).trim()

app.setAppUserModelId('digital.digitaltarget.solarpro')

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const w = getMainWindow()
    if (w) {
      if (w.isMinimized()) w.restore()
      w.focus()
    }
  })

  app.whenReady().then(boot)

  app.on('window-all-closed', () => {
    closeDatabase()
    app.quit()
  })

  app.on('before-quit', () => closeDatabase())
}

function setupPaths(): void {
  const userData = app.getPath('userData')
  const dataDir = join(userData, 'data')
  runtime.paths = {
    userData,
    dataDir,
    dbFile: join(dataDir, 'dtsolarpro.db'),
    backups: join(app.getPath('documents'), 'DT Solar Pro Backups'),
    attachments: join(dataDir, 'attachments'),
    licenseDir: join(userData, 'license')
  }
  runtime.appVersion = app.getVersion()
  runtime.isDev = !app.isPackaged
  initLog(join(userData, 'logs'))
}

function setupLicense(): void {
  runtime.license = new LicenseService({
    dir: runtime.paths.licenseDir,
    publicKeyPem,
    apiUrl: LICENSE_API_URL,
    appVersion: runtime.appVersion,
    getDbTrialStart: () => {
      const r = runtime.db?.prepare("SELECT value FROM app_meta WHERE key = 'trial_started_at'").get() as { value: string } | undefined
      return r ? Number(r.value) : null
    },
    setDbTrialStart: (ts) => {
      runtime.db?.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('trial_started_at', ?)").run(String(ts))
    },
    onChange: (s) => broadcast('dt:license', s)
  })
  runtime.license.touch()
}

function setupIpc(): void {
  ipcMain.handle('dt:call', async (event, method: unknown, args: unknown) => {
    try {
      const url = event.senderFrame?.url ?? ''
      if (!isTrustedSender(url)) throw new AppError('Untrusted caller.', 'FORBIDDEN')
      if (typeof method !== 'string' || method.length > 80) throw new AppError('Invalid request.', 'VALIDATION')
      const data = await dispatch(method, args, event.sender)
      return { ok: true, data }
    } catch (e) {
      const err = e as Error & { code?: string }
      const code = err instanceof AppError ? err.code : err.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 'DUPLICATE' : 'ERROR'
      if (!(err instanceof AppError)) log('error', `${String(method)}: ${err.stack ?? err.message}`)
      const message =
        err instanceof AppError
          ? err.message
          : code === 'DUPLICATE'
            ? 'A record with the same number or code already exists.'
            : `Something went wrong: ${err.message}. Your data has not been changed.`
      return { ok: false, error: { message, code } }
    }
  })
}

function startBackgroundJobs(): void {
  const backup = async (): Promise<void> => {
    if (!runtime.db) return
    try {
      const r = await autoBackupIfDue(runtime.db, runtime.paths.backups)
      if (r) log('info', `Automatic backup created: ${r.file}`)
    } catch (e) {
      log('error', `Automatic backup failed: ${(e as Error).message}`)
    }
  }
  setTimeout(backup, 45_000)
  setInterval(backup, 60 * 60 * 1000)

  const check = (): void => {
    runtime.license?.checkIn(true).catch(() => undefined)
  }
  setTimeout(check, 20_000)
  setInterval(check, 6 * 60 * 60 * 1000)
  setInterval(() => {
    try {
      runtime.license?.touch()
      runtime.license?.status(true)
    } catch {
      /* ignore */
    }
  }, 10 * 60 * 1000)
}

async function boot(): Promise<void> {
  setupPaths()
  const started = Date.now()
  const splash = createSplash()
  openAppDatabase()
  setupLicense()
  setupIpc()
  const main: BrowserWindow = createMainWindow()
  main.once('ready-to-show', () => {
    const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - started))
    setTimeout(() => {
      if (!splash.isDestroyed()) splash.close()
      main.maximize()
      main.show()
      main.focus()
    }, wait)
  })
  startBackgroundJobs()
  log('info', `DT Solar Pro ${runtime.appVersion} started`)
}

process.on('uncaughtException', (e) => log('error', `Uncaught: ${e.stack ?? e.message}`))
process.on('unhandledRejection', (e) => log('error', `Unhandled rejection: ${String(e)}`))

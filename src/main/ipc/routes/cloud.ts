/** IPC routes — License, registration, heartbeat, location, support messages (owner: cloud area). Owns: license.*, auth.setup, cloud.*, support.*. */
import { BrowserWindow, dialog, shell } from 'electron'
import { readFileSync } from 'fs'
import type { RouteMap } from '../common'
import { runtime, getDb } from '../../runtime'
import { AppError, Ctx, audit } from '../../services/context'
import * as auth from '../../services/auth'
import { runSetup } from '../../services/setup'
import { getCloud } from '../../cloud/worker'
import * as support from '../../cloud/support'
import { SupportError } from '../../cloud/support'
import type { LicenseService } from '../../license/service'

function license(): LicenseService {
  if (!runtime.license) throw new AppError('The license service is not ready.', 'ERROR')
  return runtime.license
}

/**
 * License routes are public because the first-run wizard (no users yet) activates the license. Once setup is done,
 * changing the license needs a signed-in, unlocked user with "license.manage" (the owner has it).
 */
function requireLicenseManager(): Ctx | null {
  const db = runtime.db
  if (!db || auth.userCount(db) === 0) return null
  const s = runtime.session
  if (!s) throw new AppError('Please sign in.', 'AUTH_REQUIRED')
  if (s.locked) throw new AppError('Session locked. Enter your password to continue.', 'LOCKED')
  if (!s.user.isOwner && !s.user.permissions.includes('license.manage')) throw new AppError('You do not have permission to change the license.', 'FORBIDDEN')
  s.lastActivity = Date.now()
  return { db, user: s.user, firmId: s.firmId }
}

function auditLicense(ctx: Ctx | null, action: string, summary: string): void {
  if (!ctx) return
  try {
    audit(ctx, action, 'license', null, summary)
  } catch {
    /* auditing must not break licensing */
  }
}

/** Sends a heartbeat soon without blocking the caller (status changes should reach Digital Target quickly). */
function heartbeatSoon(): void {
  setTimeout(() => {
    try {
      void getCloud().sendHeartbeat()
    } catch {
      /* online features unavailable */
    }
  }, 1500)
}

/** Support-queue validation errors are user errors. */
function supportCall<T>(fn: () => T): T {
  try {
    return fn()
  } catch (e) {
    if (e instanceof SupportError) throw new AppError(e.message, e.code)
    throw e
  }
}

export const cloudRoutes: RouteMap = {
  /* ------------------------------------------------ first-run setup ------------------------------------------------ */
  'auth.setup': {
    public: true,
    handler: async (_c, a) => {
      const db = getDb()
      // No local trial: the business (firm, owner, data) can only be created once a valid certificate is installed.
      const lic = runtime.license ? await runtime.license.ensureFresh() : null
      if (!lic || !lic.canWrite) {
        throw new AppError(lic && lic.mode !== 'not_activated' ? lic.message : 'Activate your license first (online or offline activation) to finish the setup.', 'LICENSE')
      }
      const r = runSetup(db, a as never)
      const user = auth.buildSessionUser(db, r.userId)
      runtime.session = { user, firmId: r.firmId, locked: false, lastActivity: Date.now() }
      // Let Digital Target see the new installation (company name, firms, users) right away.
      heartbeatSoon()
      return { user, firmId: r.firmId }
    }
  },

  /* ------------------------------------------------ license ------------------------------------------------ */
  'license.status': { public: true, handler: () => license().status(true) },
  'license.activate': {
    public: true,
    handler: async (_c, a) => {
      const ctx = requireLicenseManager()
      const r = await license().activateOnline(String(a.licenseKey ?? ''), a.registration ?? undefined)
      auditLicense(ctx, 'license', r.state === 'approved' ? 'License activated online' : 'Online activation requested')
      if (r.state === 'approved') heartbeatSoon()
      return r
    }
  },
  'license.pollActivation': {
    public: true,
    handler: async (_c, a) => {
      const r = await license().pollActivation(a?.force === true)
      if (r.state === 'approved') heartbeatSoon()
      return r
    }
  },
  'license.cancelPending': {
    public: true,
    handler: () => {
      const ctx = requireLicenseManager()
      const st = license().cancelPending()
      auditLicense(ctx, 'license', 'Pending activation request cancelled')
      return st
    }
  },
  'license.requestCode': {
    public: true,
    handler: (_c, a) => {
      requireLicenseManager()
      return license().requestCode(String(a.licenseKey ?? ''))
    }
  },
  'license.install': {
    public: true,
    handler: async (c, a) => {
      const ctx = requireLicenseManager()
      let text = a.text as string | undefined
      if (!text) {
        const win = BrowserWindow.fromWebContents(c.sender) ?? undefined
        const r = await dialog.showOpenDialog(win!, { properties: ['openFile'], title: 'Select license file', filters: [{ name: 'License', extensions: ['dtlic', 'json', 'txt'] }] })
        if (r.canceled || !r.filePaths[0]) return null
        text = readFileSync(r.filePaths[0], 'utf8')
      }
      const st = license().install(String(text).slice(0, 20000))
      auditLicense(ctx, 'license', `License installed (offline activation): ${st.payload?.businessName ?? st.mode}`)
      heartbeatSoon()
      return st
    }
  },
  'license.checkIn': {
    public: true,
    handler: async () => {
      const st = await license().checkIn(false)
      return st
    }
  },
  /** Detached lifetime license: install a reconnect / re-issued certificate published by Digital Target. */
  'license.reconnect': {
    public: true,
    handler: async () => {
      const ctx = requireLicenseManager()
      const r = await license().fetchPublishedCertificate()
      if (r.installed) {
        auditLicense(ctx, 'license', r.message)
        heartbeatSoon()
      }
      return r
    }
  },
  'license.deactivate': {
    perm: 'license.manage',
    handler: async (c) => {
      const st = await license().deactivate()
      audit(c.ctx, 'license', 'license', null, 'This computer was deactivated (license removed)')
      heartbeatSoon()
      return st
    }
  },

  /* ------------------------------------------------ heartbeat & location ------------------------------------------------ */
  // Location sharing is a privacy choice, not business data: it stays changeable (and withdrawable) when the license
  // is read-only, so these routes are not marked write.
  'cloud.overview': { perm: 'settings.manage', handler: () => getCloud().overview() },
  /** First-sign-in consent: needed only for the owner of a licensed installation that was never asked. */
  'cloud.locationPrompt': {
    handler: (c) => ({ needed: c.ctx.user.isOwner && getCloud().locationPromptNeeded() })
  },
  /**
   * The owner's answer (consent question at first sign-in, or a later change in Settings). Allowing reads the position from
   * Windows at once and reports whether Windows permits it; the operating system's permission is never bypassed.
   */
  'cloud.answerLocation': {
    perm: 'settings.manage',
    handler: async (c, a) => {
      const cloud = getCloud()
      await cloud.answerLocation(c.ctx, a.allow === true)
      return cloud.overview()
    }
  },
  /** Opens the Windows page where location access for desktop apps is turned on. */
  'cloud.openLocationSettings': {
    perm: 'settings.manage',
    handler: async () => {
      if (process.platform !== 'win32') throw new AppError('Windows location settings are only available on Windows.', 'VALIDATION')
      await shell.openExternal('ms-settings:privacy-location')
      return true
    }
  },
  'cloud.heartbeat': {
    perm: 'settings.manage',
    handler: async () => {
      const cloud = getCloud()
      await cloud.sendHeartbeat()
      return cloud.overview()
    }
  },

  /* ------------------------------------------------ support messages ------------------------------------------------ */
  // Sending a support message must work even when the license is read-only (that is when customers need help most).
  'support.overview': { perm: 'support.use', handler: () => getCloud().supportOverview() },
  'support.unread': { perm: 'support.use', handler: () => getCloud().supportOverview().counts },
  'support.send': {
    perm: 'support.use',
    handler: (c, a) => supportCall(() => getCloud().queueSupport({ body: a.body, author: c.ctx.user.fullName, userId: c.ctx.user.id }))
  },
  'support.retry': { perm: 'support.use', handler: (_c, a) => supportCall(() => getCloud().retrySupport(String(a.uid ?? ''))) },
  'support.sync': {
    perm: 'support.use',
    handler: async () => {
      const cloud = getCloud()
      const r = await cloud.syncSupport(true)
      return { result: r, overview: cloud.supportOverview() }
    }
  },
  'support.markRead': { perm: 'support.use', handler: () => getCloud().markSupportRead() },
  /** Clear chat (messages) / Delete chat (the whole conversation) on this computer. Confirmed in the UI; audited here. */
  'support.clear': {
    perm: 'support.use',
    handler: (c, a) => {
      const mode = a.mode === 'conversation' ? 'conversation' : 'messages'
      const r = supportCall(() => support.clearConversation(c.ctx.db, mode))
      audit(c.ctx, mode === 'conversation' ? 'delete' : 'clear', 'support', null, mode === 'conversation' ? 'Deleted the support conversation on this computer' : 'Cleared the support messages on this computer', r)
      return { ...r, overview: getCloud().supportOverview() }
    }
  }
}

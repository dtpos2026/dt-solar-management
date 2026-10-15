/** IPC routes — Offline help assistant and WhatsApp (owner: assist area). Owns: help.*, whatsapp.*. */
import { BrowserWindow, WebContents, shell } from 'electron'
import type { RouteMap } from '../common'
import { runtime } from '../../runtime'
import { getMainWindow } from '../../windows'
import { AppError, audit } from '../../services/context'
import { log } from '../../log'
import { HELP_ARTICLES } from '../../../shared/help/kb'
import { buildChatLink, normalizePhone } from '../../whatsapp/core'
import { buildDraft, countryCode, getLog, insertLog, listLog, parseTarget, recentDuplicate, setLogStatus } from '../../whatsapp/service'
import * as web from '../../whatsapp/web'
import { OutboxItem, fileForToken, fileSize, getCurrent, renderPdfToOutbox, setCurrent, showInFolder } from '../../whatsapp/outbox'

const WA = 'whatsapp.send'

function mainWin(sender: WebContents): BrowserWindow {
  const w = getMainWindow()
  if (!w || w.isDestroyed() || BrowserWindow.fromWebContents(sender) !== w) throw new AppError('WhatsApp is only available in the main window.', 'FORBIDDEN')
  return w
}

function num(v: unknown, label: string): number {
  const n = Number(v)
  if (!Number.isFinite(n)) throw new AppError(`${label} is invalid.`, 'VALIDATION')
  return n
}

export const assistRoutes: RouteMap = {
  /* ---------------- offline help ---------------- */
  // The knowledge base and search run in the renderer (fully offline); this route exposes the article count/ids for diagnostics.
  'help.info': { handler: () => ({ articles: HELP_ARTICLES.length, offline: true }) },

  /* ---------------- WhatsApp: built-in WhatsApp Web view ---------------- */
  'whatsapp.status': { perm: WA, handler: () => ({ ...web.status(), current: getCurrent() }) },
  'whatsapp.show': {
    perm: WA,
    handler: (c, a) => {
      if (!runtime.session || runtime.session.locked) return false
      web.show(mainWin(c.sender), { x: num(a.x, 'x'), y: num(a.y, 'y'), width: num(a.width, 'width'), height: num(a.height, 'height') })
      return true
    }
  },
  'whatsapp.hide': { handler: () => (web.hide(), true) },
  'whatsapp.reload': { perm: WA, handler: (c) => (web.reload(mainWin(c.sender)), true) },
  'whatsapp.openChat': {
    perm: WA,
    handler: (c, a) => {
      const phone = normalizePhone(a.phone, countryCode(c.ctx))
      if (!phone) throw new AppError('Enter a valid mobile number, e.g. 0300 1234567.', 'VALIDATION')
      web.openChat(mainWin(c.sender), phone, String(a.text ?? '').slice(0, 2000))
      return { phone }
    }
  },
  'whatsapp.unlink': {
    perm: WA,
    handler: async (c) => {
      await web.unlink(getMainWindow())
      audit(c.ctx, 'whatsapp_unlink', 'whatsapp', null, 'Logged out of WhatsApp Web on this computer')
      return true
    }
  },

  /* ---------------- WhatsApp: sending documents ---------------- */
  'whatsapp.draft': {
    perm: WA,
    handler: (c, a) => {
      const d = buildDraft(c.ctx, parseTarget(a))
      return { ...d, duplicate: d.phone ? recentDuplicate(c.ctx, d.entity, d.id, d.phone) : null }
    }
  },
  'whatsapp.prepare': {
    perm: WA,
    write: true,
    handler: async (c, a) => {
      const d = buildDraft(c.ctx, parseTarget(a))
      const phone = normalizePhone(a.phone, countryCode(c.ctx))
      if (!phone) throw new AppError('Enter a valid mobile number, e.g. 0300 1234567 or +92 300 1234567.', 'VALIDATION')
      const message = String(a.message ?? d.message).slice(0, 2000)
      const dup = recentDuplicate(c.ctx, d.entity, d.id, phone)
      if (dup && a.confirmDuplicate !== true) return { duplicate: dup }
      const method = d.mode === 'chat_link' ? 'chat_link' : 'whatsapp_web'
      let out: { file: string; size: number }
      try {
        out = await renderPdfToOutbox(d)
      } catch (e) {
        const reason = (e as Error).message
        insertLog(c.ctx, { entity: d.entity, id: d.id, partyId: d.partyId, phone, fileName: d.fileName, method, status: 'failed', error: `PDF: ${reason}`.slice(0, 300) })
        log('error', `WhatsApp PDF failed: ${reason}`)
        throw new AppError(`Could not prepare the PDF: ${reason}`, 'PDF')
      }
      const logId = insertLog(c.ctx, { entity: d.entity, id: d.id, partyId: d.partyId, phone, fileName: d.fileName, method, status: 'prepared' })
      const item: OutboxItem = {
        logId,
        token: web.dragTokens.issue(out.file),
        fileName: d.fileName,
        size: out.size,
        phone,
        message,
        entity: d.entity,
        entityId: d.id,
        label: d.label,
        method
      }
      setCurrent(item)
      if (method === 'chat_link') {
        await shell.openExternal(buildChatLink(phone, message))
        setLogStatus(c.ctx, logId, 'opened')
      }
      return { item, mode: d.mode }
    }
  },
  /** Opens the prepared chat inside the WhatsApp module (called by the /whatsapp page). */
  'whatsapp.openCurrent': {
    perm: WA,
    write: true,
    handler: (c, a) => {
      const item = getCurrent()
      if (!item || item.logId !== Number(a.logId)) throw new AppError('This document is no longer prepared. Send it again from the document.', 'NOT_FOUND')
      try {
        web.openChat(mainWin(c.sender), item.phone, item.message)
      } catch (e) {
        setLogStatus(c.ctx, item.logId, 'failed', (e as Error).message)
        throw e
      }
      setLogStatus(c.ctx, item.logId, 'opened')
      return item
    }
  },
  'whatsapp.current': { perm: WA, handler: () => getCurrent() },
  'whatsapp.dismiss': { perm: WA, handler: () => (setCurrent(null), true) },
  'whatsapp.showInFolder': {
    perm: WA,
    handler: (_c, a) => {
      if (!showInFolder(a.token)) throw new AppError('The PDF is no longer in the outbox. Prepare it again.', 'NOT_FOUND')
      return true
    }
  },
  'whatsapp.fileInfo': {
    perm: WA,
    handler: (_c, a) => {
      const f = fileForToken(a.token)
      return f ? { size: fileSize(f) } : null
    }
  },
  'whatsapp.markSent': {
    perm: WA,
    write: true,
    handler: (c, a) => {
      const row = setLogStatus(c.ctx, Number(a.logId), 'sent')
      const cur = getCurrent()
      if (cur && cur.logId === row.id) setCurrent(null)
      return row
    }
  },
  'whatsapp.markFailed': {
    perm: WA,
    write: true,
    handler: (c, a) => {
      const reason = String(a.reason ?? '').trim()
      if (!reason) throw new AppError('Please write the reason.', 'VALIDATION')
      const row = setLogStatus(c.ctx, Number(a.logId), 'failed', reason)
      const cur = getCurrent()
      if (cur && cur.logId === row.id) setCurrent(null)
      return row
    }
  },
  'whatsapp.log': { perm: WA, handler: (c, a) => listLog(c.ctx, a ?? {}) },
  'whatsapp.logGet': { perm: WA, handler: (c, a) => getLog(c.ctx, Number(a.id)) }
}

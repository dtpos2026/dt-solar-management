/** IPC routes - Documents & printing templates (owner: documents area). Owns: docs.*, templates.*. */
import type { RouteMap } from '../common'
import * as docs from '../../services/documents'
import * as tpl from '../../services/templates'

const PRODUCT_READERS = ['inventory.view', 'sales.create', 'purchases.create', 'quotations.manage']

export const documentRoutes: RouteMap = {
  /* ---------------- documents (extends the core docs.* routes) ---------------- */
  // Permanent delete: invoices / bills / returns follow the delete rules (permission, nothing settled or referencing it,
  // open period, stock reversible); quotations / orders / challans keep the draft rules.
  'docs.delete': { write: true, handler: (c, a) => docs.deleteDocument(c.ctx, Number(a.id)) },
  'docs.copy': { handler: (c, a) => docs.prepareCopy(c.ctx, Number(a.id)) },
  'docs.productDetails': { perm: PRODUCT_READERS, handler: (c, a) => docs.productDetails(c.ctx, a.ids) },

  /* ---------------- print templates ---------------- */
  'templates.list': { handler: (c, a) => tpl.listTemplates(c.ctx, { kind: a.kind }) },
  'templates.get': { handler: (c, a) => tpl.getTemplate(c.ctx, Number(a.id)) },
  'templates.forKind': { handler: (c, a) => tpl.templatesForKind(c.ctx, String(a.kind ?? '')) },
  'templates.defaults': { handler: (c) => tpl.getTemplateDefaults(c.ctx) },
  'templates.previewSource': { perm: 'templates.manage', handler: (c, a) => tpl.previewSource(c.ctx, String(a.kind ?? '')) },
  'templates.save': { perm: 'templates.manage', write: true, handler: (c, a) => tpl.saveTemplate(c.ctx, a as never) },
  'templates.duplicate': { perm: 'templates.manage', write: true, handler: (c, a) => tpl.duplicateTemplate(c.ctx, Number(a.id)) },
  'templates.delete': { perm: 'templates.manage', write: true, handler: (c, a) => tpl.deleteTemplate(c.ctx, Number(a.id)) },
  'templates.setDefault': { perm: 'templates.manage', write: true, handler: (c, a) => tpl.setDefaultTemplate(c.ctx, String(a.kind ?? ''), a.ref ?? null) }
}

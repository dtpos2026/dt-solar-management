/** IPC routes - CRM: leads, follow-ups, pipeline (owner: crm area). Owns: crm.*. Rules and permission checks live in services/crm.ts. */
import type { RouteMap } from '../common'
import * as crm from '../../services/crm'

export const crmRoutes: RouteMap = {
  'crm.summary': { perm: 'crm.view', handler: (c) => crm.summary(c.ctx) },
  'crm.followUps': { handler: (c) => crm.followUps(c.ctx) },
  'crm.list': { perm: 'crm.view', handler: (c, a) => crm.listLeads(c.ctx, a as never) },
  'crm.get': { perm: 'crm.view', handler: (c, a) => crm.getLead(c.ctx, Number(a.id)) },
  'crm.save': { perm: 'crm.manage', write: true, handler: (c, a) => crm.saveLead(c.ctx, a as never) },
  'crm.activity': { perm: 'crm.manage', write: true, handler: (c, a) => crm.addActivity(c.ctx, Number(a.id), a as never) },
  'crm.setStage': { perm: 'crm.manage', write: true, handler: (c, a) => crm.setStage(c.ctx, Number(a.id), String(a.stage ?? ''), { reason: typeof a.reason === 'string' ? a.reason : undefined }) },
  'crm.convert': { perm: 'crm.manage', write: true, handler: (c, a) => ({ partyId: crm.ensureCustomer(c.ctx, Number(a.id)) }) },
  'crm.delete': { perm: 'crm.manage', write: true, handler: (c, a) => crm.deleteLead(c.ctx, Number(a.id)) }
}

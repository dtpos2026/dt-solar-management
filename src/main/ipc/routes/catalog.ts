/**
 * IPC routes — Products, categories, warehouses, projects, parties, firms (owner: catalog area).
 * Owns: products.*, categories.*, warehouses.*, projects.*, firms.*, parties.*.
 * Keys defined here override the core route of the same name (router.ts). Business rules and permission checks
 * live in the services; the `perm` below is only the first gate.
 */
import { licenseLimits, type RouteMap } from '../common'
import * as inv from '../../services/inventory'
import * as proj from '../../services/projects'
import * as firms from '../../services/firms'

export const catalogRoutes: RouteMap = {
  /* ---------------- products: delete / archive / restore / category ---------------- */
  'products.usage': {
    perm: ['inventory.view', 'inventory.delete'],
    handler: (c, a) => inv.getProductUsage(c.ctx, Number(a.id))
  },
  'products.delete': { perm: 'inventory.delete', write: true, handler: (c, a) => inv.deleteProduct(c.ctx, Number(a.id)) },
  'products.archive': { perm: 'inventory.delete', write: true, handler: (c, a) => inv.archiveProducts(c.ctx, a.ids ?? a.id) },
  'products.restore': { perm: 'inventory.delete', write: true, handler: (c, a) => inv.restoreProducts(c.ctx, a.ids ?? a.id) },
  'products.setCategory': {
    perm: 'inventory.manage',
    write: true,
    handler: (c, a) => inv.changeProductsCategory(c.ctx, a.ids ?? a.id, a.categoryId ?? null)
  },

  /* ---------------- categories ---------------- */
  'categories.delete': {
    perm: 'inventory.manage',
    write: true,
    handler: (c, a) =>
      inv.deleteCategory(c.ctx, Number(a.id), { moveToCategoryId: a.moveToCategoryId ?? null, clearCategory: a.clearCategory === true })
  },

  /* ---------------- projects: pickers / delete / archive / cancel ---------------- */
  'projects.options': {
    perm: ['projects.view', 'sales.create', 'purchases.create', 'expenses.manage', 'accounts.manage', 'quotations.manage'],
    handler: (c) => proj.projectOptions(c.ctx)
  },
  'projects.links': { perm: 'projects.view', handler: (c, a) => proj.getProjectLinks(c.ctx, Number(a.id)) },
  'projects.delete': { perm: 'projects.delete', write: true, handler: (c, a) => proj.deleteProject(c.ctx, Number(a.id)) },
  'projects.archive': { perm: 'projects.delete', write: true, handler: (c, a) => proj.setProjectArchived(c.ctx, Number(a.id), true) },
  'projects.restore': { perm: 'projects.delete', write: true, handler: (c, a) => proj.setProjectArchived(c.ctx, Number(a.id), false) },
  'projects.cancel': {
    perm: 'projects.manage',
    write: true,
    handler: (c, a) => {
      proj.cancelProject(c.ctx, Number(a.id), a.reason)
      return true
    }
  },

  /* ---------------- firms: limits / activation / shared records ---------------- */
  'firms.limits': { handler: (c) => firms.firmLimits(c.ctx.db, licenseLimits().maxFirms) },
  'firms.update': { perm: 'firms.manage', write: true, handler: (c, a) => firms.updateFirm(c.ctx, a as never, licenseLimits().maxFirms) },
  'firms.deactivationImpact': { perm: 'firms.manage', handler: (c, a) => firms.firmDeactivationImpact(c.ctx, Number(a.id)) },
  'firms.setActive': {
    perm: 'firms.manage',
    write: true,
    handler: (c, a) =>
      firms.setFirmActive(c.ctx, Number(a.id), a.active === true, licenseLimits().maxFirms, { grantDefaultAccess: a.grantDefaultAccess !== false })
  },
  'firms.deleteImpact': { perm: 'firms.manage', handler: (c, a) => firms.firmDeleteImpact(c.ctx, Number(a.id)) },
  'firms.delete': { perm: 'firms.manage', write: true, handler: (c, a) => firms.deleteFirm(c.ctx, Number(a.id)) },
  'firms.sharedPlan': {
    perm: 'firms.manage',
    handler: (c) => {
      const { assignments, ...plan } = firms.planSharedAssignment(c.ctx)
      return { ...plan, productAssignments: assignments.products.length, partyAssignments: assignments.parties.length }
    }
  },
  'firms.assignShared': { perm: 'firms.manage', write: true, handler: (c) => firms.assignSharedRecords(c.ctx) }
}

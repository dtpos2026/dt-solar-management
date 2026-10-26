/** IPC routes - Point of sale (owner: pos area). Owns: pos.*. Rules and permission checks live in services/pos.ts. */
import type { RouteMap } from '../common'
import * as pos from '../../services/pos'

export const posRoutes: RouteMap = {
  'pos.status': { handler: (c) => pos.status(c.ctx) },
  'pos.openShift': { write: true, handler: (c, a) => pos.openShift(c.ctx, a as never) },
  'pos.closeShift': { write: true, handler: (c, a) => pos.closeShift(c.ctx, a as never) },
  'pos.cashMove': { write: true, handler: (c, a) => pos.cashMove(c.ctx, a as never) },
  'pos.shiftReport': { handler: (c, a) => pos.shiftReport(c.ctx, Number(a.id)) },
  'pos.shifts': { handler: (c, a) => pos.listShifts(c.ctx, a as never) },
  'pos.checkout': { write: true, handler: (c, a) => pos.checkout(c.ctx, a as never) },
  'pos.hold': { write: true, handler: (c, a) => pos.holdCart(c.ctx, a as never) },
  'pos.holds': { handler: (c) => pos.listHolds(c.ctx) },
  'pos.deleteHold': { write: true, handler: (c, a) => pos.deleteHold(c.ctx, Number(a.id)) },
  'pos.recent': { handler: (c, a) => pos.recentSales(c.ctx, a as never) }
}

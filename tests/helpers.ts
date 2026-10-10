import Database from 'better-sqlite3'
import { configure, migrate, seedDefaults, DB } from '../src/main/db'
import { buildSessionUser, saveUser } from '../src/main/services/auth'
import type { Ctx } from '../src/main/services/context'
import { runSetup } from '../src/main/services/setup'

export function freshDb(): DB {
  const db = new Database(':memory:')
  configure(db)
  migrate(db)
  seedDefaults(db)
  return db
}

export function setupCtx(opts: { demo?: boolean; shareInventory?: boolean; shareParties?: boolean } = {}): Ctx {
  const db = freshDb()
  const { userId, firmId } = runSetup(db, {
    firm: { name: 'WETCO SOLAR SOLUTIONS', phone: '03007341433', city: 'Multan' },
    owner: { username: 'admin', fullName: 'Owner', password: 'secret123' },
    shareInventory: opts.shareInventory ?? true,
    shareParties: opts.shareParties ?? true,
    demoData: opts.demo
  })
  return { db, user: buildSessionUser(db, userId), firmId }
}

export function userCtx(owner: Ctx, roleName: string, username = 'user1'): Ctx {
  const role = owner.db.prepare('SELECT id FROM roles WHERE name = ?').get(roleName) as { id: number }
  const id = saveUser(owner, { username, fullName: username, roleId: role.id, password: 'secret123', allFirms: true })
  return { db: owner.db, user: buildSessionUser(owner.db, id), firmId: owner.firmId }
}

export function warehouse(ctx: Ctx): number {
  return (ctx.db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get() as { id: number }).id
}

export function cashAccount(ctx: Ctx): number {
  return (ctx.db.prepare('SELECT id FROM accounts WHERE firm_id = ? ORDER BY id LIMIT 1').get(ctx.firmId) as { id: number }).id
}

export function qtyOf(ctx: Ctx, productId: number): number {
  return (ctx.db.prepare('SELECT COALESCE(SUM(qty),0) AS q FROM stock_levels WHERE product_id = ?').get(productId) as { q: number }).q
}

export function avgCost(ctx: Ctx, productId: number): number {
  return (ctx.db.prepare('SELECT avg_cost FROM products WHERE id = ?').get(productId) as { avg_cost: number }).avg_cost
}

/** CRM: leads, follow-ups, stages, conversion to a customer, permissions and firm scoping. Real services on a real SQLite database. */
import { describe, expect, it } from 'vitest'
import { addActivity, deleteLead, ensureCustomer, followUps, getLead, listLeads, saveLead, setStage, summary } from '../src/main/services/crm'
import { createFirm } from '../src/main/services/firms'
import { saveUser, buildSessionUser } from '../src/main/services/auth'
import { seedDefaults } from '../src/main/db'
import { today } from '../src/main/services/context'
import type { Ctx } from '../src/main/services/context'
import { setupCtx, userCtx } from './helpers'

const day = (offset: number): string => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

const lead = (ctx: Ctx, over: Record<string, unknown> = {}): number =>
  saveLead(ctx, { name: 'Ahmed Raza', phone: '0300-1234567', city: 'Multan', source: 'Referral', interest: '10 kW on-grid', systemKw: 10, expectedValue: 1_800_000, nextFollowUp: day(2), ...over } as never)

describe('CRM: leads and the activity timeline', () => {
  it('creates a lead in the New stage with a timeline entry and an audit record; validates input', () => {
    const ctx = setupCtx()
    const id = lead(ctx)
    const { lead: l, activities } = getLead(ctx, id)
    expect(l).toMatchObject({ name: 'Ahmed Raza', stage: 'new', expected_value: 1_800_000, system_kw: 10, firm_id: ctx.firmId })
    expect(activities.map((a) => a.summary)).toEqual(['Lead created'])
    expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE entity = 'lead' AND action = 'create'").get()).toEqual({ c: 1 })
    expect(() => saveLead(ctx, { name: '  ' } as never)).toThrow(/Name is required/)
    expect(() => lead(ctx, { nextFollowUp: '2026-13-45' })).toThrow(/valid|invalid/i)
    // a negative value is stored as 0, a user that does not exist cannot be assigned
    const zero = lead(ctx, { name: 'Free quote', expectedValue: -5 })
    expect(getLead(ctx, zero).lead.expected_value).toBe(0)
    expect(() => lead(ctx, { assignedTo: 9999 })).toThrow(/active user/)
    // edit keeps the stage and the history
    saveLead(ctx, { id, name: 'Ahmed Raza', phone: '0300-7654321', expectedValue: 2_000_000 } as never)
    expect(getLead(ctx, id).lead).toMatchObject({ phone: '0300-7654321', expected_value: 2_000_000, stage: 'new' })
  })

  it('logging a call moves New to Contacted and can set the next follow-up; a note changes nothing', () => {
    const ctx = setupCtx()
    const id = lead(ctx, { nextFollowUp: null })
    addActivity(ctx, id, { kind: 'note', summary: 'Found the number on Facebook' })
    expect(getLead(ctx, id).lead).toMatchObject({ stage: 'new', last_contact_at: null })
    addActivity(ctx, id, { kind: 'call', summary: 'Spoke to the owner, wants a site visit', nextFollowUp: day(3) })
    const { lead: l, activities } = getLead(ctx, id)
    expect(l.stage).toBe('contacted')
    expect(l.next_follow_up).toBe(day(3))
    expect(l.last_contact_at).toBeTruthy()
    expect(activities.map((a) => a.kind)).toEqual(['stage', 'call', 'note', 'note']) // newest first
    expect(() => addActivity(ctx, id, { kind: 'call', summary: '' })).toThrow(/required/)
    // clearing the follow-up date
    addActivity(ctx, id, { kind: 'whatsapp', summary: 'Sent photos', nextFollowUp: null })
    expect(getLead(ctx, id).lead.next_follow_up).toBeNull()
  })

  it('counts overdue, today and next-7-day follow-ups; closed leads never count', () => {
    const ctx = setupCtx()
    lead(ctx, { name: 'Overdue', nextFollowUp: day(-3) })
    lead(ctx, { name: 'Today', nextFollowUp: today() })
    lead(ctx, { name: 'Soon', nextFollowUp: day(5) })
    lead(ctx, { name: 'Far', nextFollowUp: day(30) })
    const lost = lead(ctx, { name: 'Lost one', nextFollowUp: day(-1) })
    setStage(ctx, lost, 'lost', { reason: 'Chose another company' })
    expect(followUps(ctx)).toEqual({ overdue: 1, today: 1, week: 1 })
    expect(listLeads(ctx, { due: 'overdue' }).map((r) => r.name)).toEqual(['Overdue'])
    expect(listLeads(ctx, { due: 'today' }).map((r) => r.name)).toEqual(['Today'])
    expect(listLeads(ctx, { due: 'week' }).map((r) => r.name)).toEqual(['Soon'])
    // open leads come first, ordered by follow-up date; the lost one is last
    expect(listLeads(ctx).map((r) => r.name)).toEqual(['Overdue', 'Today', 'Soon', 'Far', 'Lost one'])
    expect(listLeads(ctx, { status: 'lost' }).map((r) => r.name)).toEqual(['Lost one'])
    expect(listLeads(ctx, { q: 'multan' }).length).toBe(5)
  })
})

describe('CRM: stages and conversion to a customer', () => {
  it('Lost needs a reason; Won creates the customer once; re-opening clears the reason', () => {
    const ctx = setupCtx()
    const id = lead(ctx, { email: 'ahmed@example.com', address: 'Gulgasht Colony' })
    expect(() => setStage(ctx, id, 'lost')).toThrow(/Reason for losing/)
    expect(() => setStage(ctx, id, 'nonsense')).toThrow(/valid stage/)
    setStage(ctx, id, 'lost', { reason: 'Price too high' })
    expect(getLead(ctx, id).lead).toMatchObject({ stage: 'lost', lost_reason: 'Price too high' })
    expect(getLead(ctx, id).lead.closed_at).toBeTruthy()
    setStage(ctx, id, 'negotiation')
    expect(getLead(ctx, id).lead).toMatchObject({ stage: 'negotiation', lost_reason: null, closed_at: null })

    const { partyId } = setStage(ctx, id, 'won')
    expect(partyId).toBeGreaterThan(0)
    const party = ctx.db.prepare('SELECT * FROM parties WHERE id = ?').get(partyId) as Record<string, unknown>
    expect(party).toMatchObject({ name: 'Ahmed Raza', phone: '0300-1234567', city: 'Multan', email: 'ahmed@example.com', type: 'customer' })
    expect(getLead(ctx, id).lead).toMatchObject({ stage: 'won', party_id: partyId, next_follow_up: null })
    // winning again or converting again never creates a second customer
    setStage(ctx, id, 'quoted')
    setStage(ctx, id, 'won')
    expect(ensureCustomer(ctx, id)).toBe(partyId)
    expect((ctx.db.prepare("SELECT COUNT(*) AS c FROM parties WHERE name = 'Ahmed Raza'").get() as { c: number }).c).toBe(1)
    const trail = getLead(ctx, id).activities.map((a) => String(a.summary))
    expect(trail.some((t) => /Customer created from this lead/.test(t))).toBe(true)
    expect(trail.some((t) => /Negotiation to Won/.test(t))).toBe(true)
  })

  it('summary: pipeline value of open leads, per stage, won this month and the conversion rate', () => {
    const ctx = setupCtx()
    lead(ctx, { name: 'A', expectedValue: 100 })
    const b = lead(ctx, { name: 'B', expectedValue: 200 })
    setStage(ctx, b, 'quoted')
    const c = lead(ctx, { name: 'C', expectedValue: 300 })
    setStage(ctx, c, 'won')
    const d = lead(ctx, { name: 'D', expectedValue: 400 })
    setStage(ctx, d, 'lost', { reason: 'No budget' })
    const s = summary(ctx)
    expect(s.open).toBe(2)
    expect(s.pipelineValue).toBe(300)
    expect(s.byStage.find((x) => x.stage === 'quoted')).toMatchObject({ count: 1, value: 200 })
    expect(s.wonThisMonth).toEqual({ count: 1, value: 300 })
    expect(s.conversionPct).toBe(50)
  })
})

describe('CRM: permissions, firms and deleting', () => {
  it('Salesperson works the pipeline, Project Manager only reads, Accountant has no access', () => {
    const owner = setupCtx()
    const id = lead(owner)
    const sales = userCtx(owner, 'Salesperson', 'seller')
    expect(listLeads(sales).length).toBe(1)
    expect(() => lead(sales, { name: 'By the salesperson' })).not.toThrow()
    const pm = userCtx(owner, 'Project Manager', 'pm1')
    expect(listLeads(pm).length).toBe(2)
    expect(() => lead(pm)).toThrow(/permission/i)
    expect(() => addActivity(pm, id, { kind: 'call', summary: 'x' })).toThrow(/permission/i)
    expect(() => setStage(pm, id, 'won')).toThrow(/permission/i)
    expect(() => deleteLead(pm, id)).toThrow(/permission/i)
    const acc = userCtx(owner, 'Accountant', 'acc1')
    expect(() => listLeads(acc)).toThrow(/permission/i)
    expect(followUps(acc)).toEqual({ overdue: 0, today: 0, week: 0 }) // the bell never throws
  })

  it('winning needs the right to manage customers; the stage is not changed when it is refused', () => {
    const owner = setupCtx()
    owner.db.prepare("INSERT INTO roles (name, description, permissions, is_system) VALUES ('Telecaller', 'calls only', '[\"crm.view\",\"crm.manage\"]', 0)").run()
    const roleId = (owner.db.prepare("SELECT id FROM roles WHERE name = 'Telecaller'").get() as { id: number }).id
    const uid = saveUser(owner, { username: 'caller', fullName: 'Caller', roleId, password: 'Caller-pass-1', allFirms: true })
    const caller: Ctx = { ...owner, user: buildSessionUser(owner.db, uid) }
    const id = lead(caller)
    expect(() => setStage(caller, id, 'won')).toThrow(/permission/i)
    expect(getLead(owner, id).lead).toMatchObject({ stage: 'new', party_id: null })
    expect(owner.db.prepare("SELECT COUNT(*) AS c FROM parties WHERE name = 'Ahmed Raza'").get()).toEqual({ c: 0 })
    // the owner can then win it
    expect(setStage(owner, id, 'won').partyId).toBeGreaterThan(0)
  })

  it('leads belong to a firm; delete removes the lead and its timeline and is audited; a firm with leads cannot be deleted', () => {
    const owner = setupCtx()
    const id = lead(owner)
    const other = createFirm(owner, { name: 'Branch Lahore' }, 5)
    const ctx2: Ctx = { ...owner, firmId: other }
    expect(listLeads(ctx2)).toEqual([])
    expect(() => getLead(ctx2, id)).toThrow(/not found/)
    expect(() => setStage(ctx2, id, 'won')).toThrow(/not found/)
    const id2 = lead(ctx2, { name: 'Lahore enquiry' })
    deleteLead(owner, id)
    expect(owner.db.prepare('SELECT COUNT(*) AS c FROM lead_activities WHERE lead_id = ?').get(id)).toEqual({ c: 0 })
    expect(listLeads(owner)).toEqual([])
    expect(owner.db.prepare("SELECT COUNT(*) AS c FROM audit_log WHERE entity = 'lead' AND action = 'delete'").get()).toEqual({ c: 1 })
    expect(listLeads(ctx2).map((r) => r.id)).toEqual([id2])
  })

  it('existing installations get the CRM permissions on the matching built-in roles when they upgrade', () => {
    const ctx = setupCtx()
    const roles = (): Record<string, string[]> => Object.fromEntries((ctx.db.prepare('SELECT name, permissions FROM roles').all() as Array<{ name: string; permissions: string }>).map((r) => [r.name, JSON.parse(r.permissions)]))
    // an installation made before CRM existed
    for (const [name, perms] of Object.entries(roles())) ctx.db.prepare('UPDATE roles SET permissions = ? WHERE name = ?').run(JSON.stringify(perms.filter((p) => !p.startsWith('crm.'))), name)
    ctx.db.prepare("UPDATE settings SET value = '2' WHERE key = 'permissions_version'").run()
    seedDefaults(ctx.db)
    const after = roles()
    expect(after['Salesperson']).toEqual(expect.arrayContaining(['crm.view', 'crm.manage']))
    expect(after['Project Manager']).toEqual(expect.arrayContaining(['crm.view']))
    expect(after['Project Manager']).not.toContain('crm.manage')
    expect(after['Accountant']).not.toContain('crm.view')
  })
})

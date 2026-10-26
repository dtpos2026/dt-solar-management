/** Service and warranty tickets: warranty check from the sold serial, ticket life cycle, timeline, permissions. Real services on a real SQLite database. */
import { describe, expect, it } from 'vitest'
import { createAdjustment, saveProduct } from '../src/main/services/inventory'
import { saveParty } from '../src/main/services/parties'
import { createDocument } from '../src/main/services/documents'
import { updateSettings } from '../src/main/services/settings'
import { addActivity, deleteTicket, getTicket, listTickets, saveTicket, setTicketStatus, ticketSummary, warrantyCheck } from '../src/main/services/service'
import { today } from '../src/main/services/context'
import { setupCtx, userCtx, warehouse } from './helpers'

const day = (offset: number): string => {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function shop() {
  const ctx = setupCtx()
  const wh = warehouse(ctx)
  const inv = saveProduct(ctx, { name: 'Inverex 3kW Inverter', salePrice: 120000, trackSerial: true, warrantyMonths: 12 })
  createAdjustment(ctx, { date: '2020-01-01', warehouseId: wh, kind: 'opening', lines: [{ productId: inv, qty: 4, unitCost: 90000, serials: 'INV-001, INV-002, INV-003, INV-004' }] })
  const cust = saveParty(ctx, { type: 'customer', name: 'Hussain Agro Farms', phone: '0333-7654321' })
  const sell = (serial: string, date: string) =>
    createDocument(ctx, { docType: 'sale_invoice', date, partyId: cust, warehouseId: wh, lines: [{ productId: inv, description: 'Inverter', qty: 1, rate: 120000, serials: serial }] })
  const recent = sell('INV-001', day(-60))
  const old = sell('INV-002', '2021-06-01')
  updateSettings(ctx, { erp_modules: { service: true } })
  return { ctx, inv, cust, recent, old }
}

describe('service tickets', () => {
  it('is off until the module is switched on', () => {
    const ctx = setupCtx()
    expect(() => listTickets(ctx)).toThrow(/switched off/)
  })

  it('checks the warranty from the sold serial number', () => {
    const { ctx, recent, cust } = shop()
    const w = warrantyCheck(ctx, { serial: 'INV-001' }) as Record<string, any>
    expect(w).toMatchObject({ found: true, productName: 'Inverex 3kW Inverter', partyId: cust, documentId: recent, warrantyMonths: 12, underWarranty: true, soldDate: day(-60) })
    expect(w.expires > today()).toBe(true)
    expect(warrantyCheck(ctx, { serial: 'INV-002' })).toMatchObject({ found: true, underWarranty: false })
    expect(warrantyCheck(ctx, { serial: 'INV-003' })).toEqual({ found: false, serial: 'INV-003' }) // still in stock, not sold
    expect(warrantyCheck(ctx, { serial: 'NOPE' })).toEqual({ found: false, serial: 'NOPE' })
    expect(() => warrantyCheck(ctx, { serial: '  ' })).toThrow(/required/)
  })

  it('opens a ticket from a serial number: customer, item, invoice and warranty are filled in', () => {
    const { ctx, inv, cust, recent, old } = shop()
    const id = saveTicket(ctx, { serial: 'INV-001', issue: 'Shows E04 and trips', priority: 'high', promisedDate: day(3) })
    const { ticket, activities } = getTicket(ctx, id)
    expect(ticket).toMatchObject({ number: 'SRV-00001', party_id: cust, product_id: inv, document_id: recent, under_warranty: 1, status: 'new', priority: 'high', customer: 'Hussain Agro Farms', document_number: expect.stringMatching(/^INV-/) })
    expect(activities).toHaveLength(1)
    expect((activities[0] as { summary: string }).summary).toMatch(/under warranty/)
    const out = saveTicket(ctx, { serial: 'INV-002', issue: 'No output' })
    expect((getTicket(ctx, out).ticket as Record<string, unknown>)).toMatchObject({ number: 'SRV-00002', under_warranty: 0, document_id: old })
    // a walk-in repair has no sale behind it
    const walk = saveTicket(ctx, { customerName: 'Bilal', phone: '0300-1', itemName: 'Old UPS', issue: 'Battery weak' })
    expect(getTicket(ctx, walk).ticket).toMatchObject({ party_id: null, customer: 'Bilal', item: 'Old UPS' })
  })

  it('checks the input', () => {
    const { ctx } = shop()
    expect(() => saveTicket(ctx, { customerName: 'A', issue: ' ' })).toThrow(/What is wrong/)
    expect(() => saveTicket(ctx, { issue: 'Broken' })).toThrow(/customer/)
    expect(() => saveTicket(ctx, { customerName: 'A', issue: 'Broken', receivedDate: day(0), promisedDate: day(-2) })).toThrow(/before the received date/)
    expect(() => saveTicket(ctx, { customerName: 'A', issue: 'Broken', assignedTo: 9999 })).toThrow(/active user/)
  })

  it('follows a ticket: timeline, resolve needs what was done, close, reopen', () => {
    const { ctx } = shop()
    const id = saveTicket(ctx, { customerName: 'Bilal', issue: 'Not charging', charges: -50 })
    expect((getTicket(ctx, id).ticket as Record<string, unknown>).charges).toBe(0)
    addActivity(ctx, id, { kind: 'call', summary: 'Called, will bring it tomorrow' })
    setTicketStatus(ctx, id, { status: 'in_progress' })
    expect(() => setTicketStatus(ctx, id, { status: 'resolved' })).toThrow(/what was done/)
    setTicketStatus(ctx, id, { status: 'resolved', resolution: 'Replaced the charging board', charges: 2500 })
    expect(getTicket(ctx, id).ticket).toMatchObject({ status: 'resolved', resolution: 'Replaced the charging board', charges: 2500, resolved_date: today() })
    setTicketStatus(ctx, id, { status: 'closed' })
    expect(() => addActivity(ctx, id, { summary: 'late note' })).toThrow(/closed/)
    expect(() => saveTicket(ctx, { id, customerName: 'Bilal', issue: 'x' })).toThrow(/closed ticket cannot be edited/)
    expect(() => setTicketStatus(ctx, id, { status: 'resolved', resolution: 'x' })).toThrow(/can only be reopened/)
    setTicketStatus(ctx, id, { status: 'in_progress' })
    expect(getTicket(ctx, id).ticket).toMatchObject({ status: 'in_progress', resolved_date: null })
    expect(getTicket(ctx, id).activities.length).toBeGreaterThanOrEqual(5)
  })

  it('lists open tickets by priority, flags the late ones, searches, summarises and deletes only untouched tickets', () => {
    const { ctx } = shop()
    const low = saveTicket(ctx, { customerName: 'A', issue: 'Cosmetic scratch', priority: 'low' })
    const urgent = saveTicket(ctx, { customerName: 'B', issue: 'Smoke from inverter', priority: 'urgent', promisedDate: day(-1), receivedDate: day(-4) })
    const done = saveTicket(ctx, { customerName: 'C', issue: 'Fuse', priority: 'normal' })
    setTicketStatus(ctx, done, { status: 'resolved', resolution: 'Fuse changed' })
    const rows = listTickets(ctx, { open: true }) as Array<Record<string, any>>
    expect(rows.map((r) => r.id)).toEqual([urgent, low])
    expect(rows[0].overdue).toBe(true)
    expect(rows[1].overdue).toBe(false)
    expect((listTickets(ctx, { q: 'smoke' }) as unknown[]).length).toBe(1)
    expect((listTickets(ctx, { status: 'resolved' }) as unknown[]).length).toBe(1)
    expect(ticketSummary(ctx)).toMatchObject({ new: 2, resolved: 1, open: 2, overdue: 1 })
    expect(() => deleteTicket(ctx, done)).toThrow(/Close it instead/)
    addActivity(ctx, low, { summary: 'Called customer' })
    expect(() => deleteTicket(ctx, low)).toThrow(/Close it instead/)
    const fresh = saveTicket(ctx, { customerName: 'D', issue: 'Wrong entry' })
    deleteTicket(ctx, fresh)
    expect((listTickets(ctx) as unknown[]).length).toBe(3)
  })

  it('a Salesperson works tickets, an Accountant cannot', () => {
    const { ctx } = shop()
    const sales = userCtx(ctx, 'Salesperson', 'sales1')
    expect(saveTicket(sales, { customerName: 'A', issue: 'x' })).toBeGreaterThan(0)
    expect(() => listTickets(userCtx(ctx, 'Accountant', 'acct1'))).toThrow(/permission/i)
  })
})

import type { DB } from '../db'
import { OWNER_ROLE_NAME } from '../../shared/permissions'
import { AppError, Ctx, requireText, setSetting } from './context'
import { buildSessionUser, hashPassword, userCount, validatePassword } from './auth'
import { FirmInput, insertFirm } from './firms'
import { saveParty } from './parties'
import { createAdjustment, defaultWarehouseId, saveProduct } from './inventory'
import { createDocument } from './documents'
import { createPayment, defaultAccountId } from './payments'
import { saveProject, createMaterialMove } from './projects'
import { createExpense } from './expenses'
import { addActivity, saveLead, setStage } from './crm'

export interface SetupInput {
  firm: FirmInput
  owner: { username: string; fullName: string; password: string; email?: string; phone?: string }
  multiFirm?: boolean
  shareInventory?: boolean
  shareParties?: boolean
  currencySymbol?: string
  extraFirms?: string[]
  demoData?: boolean
}

export function runSetup(db: DB, input: SetupInput): { userId: number; firmId: number } {
  if (userCount(db) > 0) throw new AppError('Setup has already been completed.', 'VALIDATION')
  const username = requireText(input.owner?.username, 'Username', 50).toLowerCase()
  if (!/^[a-z0-9._-]{3,50}$/.test(username)) throw new AppError('Username may contain letters, numbers, dot, dash and underscore (min 3).', 'VALIDATION')
  const fullName = requireText(input.owner?.fullName, 'Full name', 100)
  const password = validatePassword(input.owner?.password)
  return db.transaction(() => {
    setSetting(db, 'multi_firm_enabled', input.multiFirm !== false)
    setSetting(db, 'share_inventory', input.shareInventory !== false)
    setSetting(db, 'share_parties', input.shareParties !== false)
    if (input.currencySymbol) setSetting(db, 'currency_symbol', String(input.currencySymbol).slice(0, 8))
    const firmId = insertFirm(db, input.firm, true)
    const extra = (input.extraFirms ?? []).map((s) => String(s).trim()).filter(Boolean).slice(0, 4)
    for (const name of extra) insertFirm(db, { name }, false)
    const role = db.prepare('SELECT id FROM roles WHERE name = ?').get(OWNER_ROLE_NAME) as { id: number }
    const userId = Number(
      db
        .prepare(
          `INSERT INTO users (username, full_name, email, phone, password_hash, role_id, is_owner, is_active, all_firms, last_firm_id)
           VALUES (?, ?, ?, ?, ?, ?, 1, 1, 1, ?)`
        )
        .run(username, fullName, input.owner.email ?? null, input.owner.phone ?? null, hashPassword(password), role.id, firmId).lastInsertRowid
    )
    db.prepare(
      `INSERT INTO audit_log (user_id, username, firm_id, action, entity, entity_id, summary) VALUES (?, ?, ?, 'setup', 'system', NULL, 'Initial setup completed')`
    ).run(userId, username, firmId)
    if (input.demoData) {
      const ctx: Ctx = { db, user: buildSessionUser(db, userId), firmId }
      seedDemoData(ctx)
    }
    return { userId, firmId }
  })()
}

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86400000)
  return d.toISOString().slice(0, 10)
}

/** Sample data for demonstrations / training. Created through the normal services so every rule applies. */
export function seedDemoData(ctx: Ctx): void {
  const db = ctx.db
  const cat = (name: string): number | null => (db.prepare('SELECT id FROM categories WHERE name = ?').get(name) as { id: number } | undefined)?.id ?? null
  const wh = defaultWarehouseId(ctx)
  const p = (name: string, category: string, purchase: number, sale: number, extra: Record<string, unknown> = {}): number =>
    saveProduct(ctx, { name, categoryId: cat(category), purchasePrice: purchase, salePrice: sale, unit: 'pcs', reorderLevel: 5, ...extra })
  const panel = p('Longi Hi-MO 6 585W Mono PERC Panel', 'Solar Panels', 26500, 29500, { brand: 'Longi', model: 'LR5-72HTH-585M', warrantyMonths: 144, reorderLevel: 20, sku: 'PNL-585' })
  const jinko = p('Jinko Tiger Neo 580W N-Type Panel', 'Solar Panels', 25800, 28900, { brand: 'Jinko', warrantyMonths: 144, sku: 'PNL-580' })
  const inv10 = p('Growatt 10kW On-Grid Inverter', 'On-Grid Inverters', 285000, 320000, { brand: 'Growatt', warrantyMonths: 60, reorderLevel: 2, sku: 'INV-GW10', trackSerial: false })
  const hyb6 = p('Inverex Nitrox 6kW Hybrid Inverter', 'Hybrid Inverters', 168000, 192000, { brand: 'Inverex', warrantyMonths: 24, reorderLevel: 2, sku: 'INV-NX6' })
  const bat = p('Lithium Battery 51.2V 100Ah (5kWh)', 'Batteries', 245000, 275000, { warrantyMonths: 60, reorderLevel: 2, sku: 'BAT-5K' })
  const stru = p('Galvanized Mounting Structure (per panel)', 'Mounting Structures', 3800, 4800, { reorderLevel: 30, sku: 'STR-GI' })
  const dc = p('DC Cable 6mm (per meter)', 'DC Cables', 210, 280, { unit: 'm', reorderLevel: 100, sku: 'CBL-DC6' })
  const ac = p('AC Cable 10mm 4-Core (per meter)', 'AC Cables', 950, 1200, { unit: 'm', reorderLevel: 50, sku: 'CBL-AC10' })
  const brk = p('DC Breaker 2P 32A', 'Breakers & Protection', 1400, 2000, { reorderLevel: 10, sku: 'BRK-DC32' })
  const spd = p('Surge Protection Device (SPD) DC 1000V', 'Breakers & Protection', 2300, 3200, { reorderLevel: 6, sku: 'SPD-DC' })
  const install = saveProduct(ctx, { name: 'Installation & Commissioning (per kW)', categoryId: cat('Services & Labor'), type: 'service', unit: 'kW', salePrice: 6000 })
  const nm = saveProduct(ctx, { name: 'Net Metering Documentation & Approval', categoryId: cat('Services & Labor'), type: 'service', unit: 'job', salePrice: 45000 })

  const sup1 = saveParty(ctx, { type: 'supplier', name: 'SolarTech Distributors Lahore', phone: '0300-1112233', city: 'Lahore', address: 'Hall Road, Lahore' })
  const sup2 = saveParty(ctx, { type: 'supplier', name: 'Multan Electric Store', phone: '0301-4455667', city: 'Multan' })
  const contractor = saveParty(ctx, { type: 'supplier', name: 'Ali Installation Team (Contractor)', phone: '0302-9988776', city: 'Multan' })
  const c1 = saveParty(ctx, { type: 'customer', name: 'Ahmed Raza', phone: '0303-1234567', city: 'Multan', address: 'Gulgasht Colony, Multan' })
  const c2 = saveParty(ctx, { type: 'customer', name: 'Green Valley School', phone: '061-6543210', city: 'Multan', address: 'Bosan Road, Multan' })
  const c3 = saveParty(ctx, { type: 'customer', name: 'Hussain Agro Farms', phone: '0333-7654321', city: 'Shujabad' })
  const acc = defaultAccountId(ctx)!

  createAdjustment(ctx, {
    date: daysAgo(60),
    warehouseId: wh,
    kind: 'opening',
    reason: 'Opening stock',
    lines: [
      { productId: panel, qty: 40, unitCost: 26000 },
      { productId: stru, qty: 60, unitCost: 3700 },
      { productId: dc, qty: 500, unitCost: 200 },
      { productId: brk, qty: 20, unitCost: 1350 }
    ]
  })
  const pi = createDocument(ctx, {
    docType: 'purchase_invoice',
    date: daysAgo(45),
    partyId: sup1,
    warehouseId: wh,
    partyRef: 'ST-7781',
    lines: [
      { productId: jinko, description: 'Jinko Tiger Neo 580W N-Type Panel', qty: 30, rate: 25800 },
      { productId: inv10, description: 'Growatt 10kW On-Grid Inverter', qty: 3, rate: 285000 },
      { productId: hyb6, description: 'Inverex Nitrox 6kW Hybrid Inverter', qty: 4, rate: 168000 },
      { productId: bat, description: 'Lithium Battery 51.2V 100Ah (5kWh)', qty: 4, rate: 245000 }
    ],
    payment: { amount: 1500000, accountId: acc, method: 'bank_transfer' }
  })
  createDocument(ctx, {
    docType: 'purchase_invoice',
    date: daysAgo(40),
    partyId: sup2,
    warehouseId: wh,
    lines: [
      { productId: ac, description: 'AC Cable 10mm 4-Core (per meter)', qty: 200, rate: 950 },
      { productId: spd, description: 'Surge Protection Device (SPD) DC 1000V', qty: 15, rate: 2300 }
    ]
  })
  void pi

  // Counter sale
  createDocument(ctx, {
    docType: 'sale_invoice',
    date: daysAgo(20),
    partyId: c1,
    warehouseId: wh,
    lines: [
      { productId: hyb6, description: 'Inverex Nitrox 6kW Hybrid Inverter', qty: 1, rate: 192000 },
      { productId: bat, description: 'Lithium Battery 51.2V 100Ah (5kWh)', qty: 1, rate: 275000 },
      { productId: panel, description: 'Longi Hi-MO 6 585W Mono PERC Panel', qty: 10, rate: 29500 }
    ],
    payment: { amount: 600000, accountId: acc, method: 'cash' }
  })

  // Project: 25 kW school on-grid
  const prj = saveProject(ctx, {
    name: 'Green Valley School 25kW On-Grid',
    customerId: c2,
    siteAddress: 'Bosan Road, Multan',
    city: 'Multan',
    capacityKw: 25,
    projectType: 'commercial',
    systemType: 'on_grid',
    startDate: daysAgo(30),
    expectedEndDate: daysAgo(-5),
    status: 'in_progress',
    progress: 70,
    contractAmount: 3150000,
    warrantyInfo: 'Panels: 12 years product warranty, 25 years performance. Inverters: 5 years. Workmanship: 1 year.'
  })
  createPayment(ctx, { date: daysAgo(30), direction: 'in', partyId: c2, accountId: acc, amount: 1500000, method: 'cheque', reference: 'Advance', projectId: prj, notes: 'Project advance' })
  createMaterialMove(ctx, {
    projectId: prj,
    direction: 'issue',
    date: daysAgo(25),
    warehouseId: wh,
    lines: [
      { productId: jinko, qty: 22 },
      { productId: inv10, qty: 2 },
      { productId: stru, qty: 22 },
      { productId: dc, qty: 180 },
      { productId: ac, qty: 40 },
      { productId: brk, qty: 4 },
      { productId: spd, qty: 2 }
    ]
  })
  const labor = (db.prepare("SELECT id FROM expense_categories WHERE cost_head = 'labor' LIMIT 1").get() as { id: number }).id
  const transport = (db.prepare("SELECT id FROM expense_categories WHERE cost_head = 'transport' LIMIT 1").get() as { id: number }).id
  const rent = (db.prepare("SELECT id FROM expense_categories WHERE name = 'Office Rent'").get() as { id: number }).id
  createExpense(ctx, { date: daysAgo(22), categoryId: labor, projectId: prj, amount: 95000, paid: false, partyId: contractor, notes: 'Installation team - 25kW' })
  createExpense(ctx, { date: daysAgo(24), categoryId: transport, projectId: prj, amount: 18000, paid: true, accountId: acc, payeeName: 'Loader Rickshaw' })
  createExpense(ctx, { date: daysAgo(10), categoryId: rent, amount: 60000, paid: true, accountId: acc, payeeName: 'Hadi Commercial Center' })
  createDocument(ctx, {
    docType: 'sale_invoice',
    date: daysAgo(8),
    partyId: c2,
    projectId: prj,
    deductStock: false,
    warehouseId: wh,
    dueDate: daysAgo(-7),
    lines: [
      { description: '25kW On-Grid Solar System - supply of panels, inverters, structure & BOS', qty: 1, rate: 2850000 },
      { productId: install, description: 'Installation & Commissioning (per kW)', qty: 25, rate: 6000, unit: 'kW' },
      { productId: nm, description: 'Net Metering Documentation & Approval', qty: 1, rate: 45000 }
    ],
    applyAdvance: true
  })

  // Pipeline project with quotation
  const q = createDocument(ctx, {
    docType: 'quotation',
    date: daysAgo(3),
    partyId: c3,
    validUntil: daysAgo(-4),
    lines: [
      { productId: panel, description: 'Longi Hi-MO 6 585W Mono PERC Panel', qty: 18, rate: 29500 },
      { productId: inv10, description: 'Growatt 10kW On-Grid Inverter', qty: 1, rate: 320000 },
      { productId: stru, description: 'Galvanized Mounting Structure (per panel)', qty: 18, rate: 4800 },
      { productId: install, description: 'Installation & Commissioning (per kW)', qty: 10, rate: 6000, unit: 'kW' }
    ],
    status: 'sent'
  })
  saveProject(ctx, {
    name: 'Hussain Agro Farms 10kW Tube-well',
    customerId: c3,
    city: 'Shujabad',
    capacityKw: 10.5,
    projectType: 'agricultural',
    systemType: 'on_grid',
    status: 'quoted',
    progress: 10,
    quotationId: q,
    contractAmount: 1055400
  })

  // CRM: a few enquiries at different stages so the pipeline, follow-ups and conversion can be seen straight away.
  // Follow-up dates are calendar days on this computer (the same "today" the CRM uses), not UTC days.
  const ahead = (n: number): string => {
    const d = new Date()
    d.setDate(d.getDate() + n)
    const p = (x: number): string => String(x).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
  const lead = (name: string, v: { phone: string; city: string; interest: string; kw: number; value: number; source: string; follow: number | null; notes?: string }): number =>
    saveLead(ctx, { name, phone: v.phone, city: v.city, interest: v.interest, systemKw: v.kw, expectedValue: v.value, source: v.source, nextFollowUp: v.follow === null ? null : ahead(v.follow), notes: v.notes })
  const l1 = lead('Bilal Traders', { phone: '0301-5550101', city: 'Multan', interest: 'On-grid for a warehouse', kw: 15, value: 2400000, source: 'Facebook', follow: 2 })
  addActivity(ctx, l1, { kind: 'call', summary: 'Owner wants to cut the electricity bill; asked for a site visit' })
  addActivity(ctx, l1, { kind: 'visit', summary: 'Visited the roof, 15 kW fits on the south side', nextFollowUp: ahead(2) })
  setStage(ctx, l1, 'site_visit')
  const l2 = lead('Dr. Saima Clinic', { phone: '0302-5550102', city: 'Khanewal', interest: 'Hybrid system with battery backup', kw: 8, value: 1650000, source: 'Referral', follow: 0 })
  addActivity(ctx, l2, { kind: 'whatsapp', summary: 'Sent photos of two similar clinics we installed' })
  addActivity(ctx, l2, { kind: 'meeting', summary: 'Quotation explained, will decide this week', nextFollowUp: ahead(0) })
  setStage(ctx, l2, 'quoted')
  const l3 = lead('Noor Textile Mills', { phone: '0303-5550103', city: 'Multan', interest: 'Large on-grid plant', kw: 100, value: 14500000, source: 'Walk-in', follow: -2, notes: 'Decision maker is the managing director' })
  addActivity(ctx, l3, { kind: 'meeting', summary: 'Presented payback calculation to the directors', nextFollowUp: ahead(-2) })
  setStage(ctx, l3, 'negotiation')
  const l4 = lead('Imran Khan', { phone: '0304-5550104', city: 'Bahawalpur', interest: 'Off-grid for a farmhouse', kw: 5, value: 780000, source: 'WhatsApp', follow: 1 })
  void l4
  const l5 = lead('Al-Hamd Poultry Farm', { phone: '0305-5550105', city: 'Vehari', interest: 'Solar for sheds and pumps', kw: 25, value: 3600000, source: 'Phone call', follow: 5 })
  addActivity(ctx, l5, { kind: 'call', summary: 'Called back, will send electricity bills first', nextFollowUp: ahead(5) })
  const l6 = lead('Hamza Electronics', { phone: '0306-5550106', city: 'Multan', interest: 'Shop rooftop system', kw: 6, value: 950000, source: 'Walk-in', follow: null })
  addActivity(ctx, l6, { kind: 'call', summary: 'Compared our quotation with another installer' })
  setStage(ctx, l6, 'lost', { reason: 'Chose a cheaper local installer' })
  // a won lead that is the existing customer Green Valley School
  const l7 = lead('Green Valley School', { phone: '061-6543210', city: 'Multan', interest: '25 kW on-grid for the school', kw: 25, value: 3150000, source: 'Referral', follow: null })
  addActivity(ctx, l7, { kind: 'meeting', summary: 'Contract signed with the school management' })
  ctx.db.prepare("UPDATE leads SET stage = 'won', party_id = ?, closed_at = datetime('now','localtime') WHERE id = ?").run(c2, l7)
  ctx.db.prepare("INSERT INTO lead_activities (lead_id, kind, summary, user_id, username) VALUES (?, 'stage', 'Stage: Contacted to Won', ?, ?)").run(l7, ctx.user.id, ctx.user.username)
}

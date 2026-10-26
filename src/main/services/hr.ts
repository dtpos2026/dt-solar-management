/**
 * HR and payroll: employees, daily attendance, salary advances and the monthly salary sheet.
 * Paying a salary sheet books one expense per employee (category Salaries, paid from a cash or bank account) so the profit and
 * loss and the account balances are right. A salary advance is booked as an expense when it is given; the salary sheet then only
 * pays what is left after the advance is taken back. The module is switched on in Settings, Simple / Customize.
 */
import { ATTENDANCE_STATUSES, computeSalary, daysInMonth, isMonth } from '../../shared/payroll'
import { num, round2 } from '../../shared/money'
import type { DB } from '../db'
import { AppError, Ctx, audit, optText, requireDate, requirePerm, requireText, today } from './context'
import { nextNumber } from './firms'
import { insertExpense, voidExpense } from './expenses'
import { assertAccount } from './payments'
import { assertModule } from './moduleGate'

const gate = (ctx: Ctx, perm: string): void => {
  assertModule(ctx, 'hr')
  requirePerm(ctx, perm)
}

interface EmployeeRow {
  id: number
  firm_id: number
  code: string
  name: string
  salary: number
  pay_type: 'monthly' | 'daily'
  status: string
  join_date: string | null
  left_date: string | null
}

export interface EmployeeInput {
  id?: number
  name: string
  phone?: string
  cnic?: string
  designation?: string
  department?: string
  joinDate?: string | null
  salary: number
  payType?: string
  notes?: string
}

function getEmployee(ctx: Ctx, id: number): EmployeeRow {
  const e = ctx.db.prepare('SELECT * FROM employees WHERE id = ? AND firm_id = ?').get(id, ctx.firmId) as EmployeeRow | undefined
  if (!e) throw new AppError('Employee not found.', 'NOT_FOUND')
  return e
}

export function advanceBalance(db: DB, employeeId: number): number {
  const r = db
    .prepare("SELECT COALESCE(SUM(CASE WHEN kind = 'advance' THEN amount WHEN kind = 'recovery' THEN -amount ELSE 0 END), 0) AS b FROM employee_ledger WHERE employee_id = ?")
    .get(employeeId) as { b: number }
  return round2(r.b)
}

export function listEmployees(ctx: Ctx, f: { status?: string; q?: string } = {}): unknown[] {
  gate(ctx, 'hr.view')
  const rows = ctx.db
    .prepare(
      `SELECT e.* FROM employees e WHERE e.firm_id = @firmId AND (@status IS NULL OR e.status = @status)
          AND (@q IS NULL OR e.name LIKE @q OR e.code LIKE @q OR e.designation LIKE @q OR e.phone LIKE @q) ORDER BY e.status, e.name`
    )
    .all({ firmId: ctx.firmId, status: f.status || null, q: f.q ? `%${f.q}%` : null }) as EmployeeRow[]
  return rows.map((e) => ({ ...e, advance_balance: advanceBalance(ctx.db, e.id) }))
}

export function getEmployeeDetail(ctx: Ctx, id: number): Record<string, unknown> {
  gate(ctx, 'hr.view')
  const e = getEmployee(ctx, id)
  return {
    employee: { ...e, ...(ctx.db.prepare('SELECT phone, cnic, designation, department, notes FROM employees WHERE id = ?').get(id) as object), advance_balance: advanceBalance(ctx.db, id) },
    ledger: ctx.db.prepare('SELECT * FROM employee_ledger WHERE employee_id = ? ORDER BY date DESC, id DESC LIMIT 100').all(id),
    payslips: ctx.db
      .prepare('SELECT l.*, r.month, r.status AS run_status FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE l.employee_id = ? ORDER BY r.month DESC LIMIT 24')
      .all(id)
  }
}

export function saveEmployee(ctx: Ctx, input: EmployeeInput): number {
  gate(ctx, 'hr.manage')
  const name = requireText(input.name, 'Name', 120)
  const salary = round2(num(input.salary))
  if (salary < 0) throw new AppError('The salary cannot be negative.', 'VALIDATION')
  const payType = input.payType === 'daily' ? 'daily' : 'monthly'
  const v = {
    name,
    phone: optText(input.phone, 40),
    cnic: optText(input.cnic, 20),
    designation: optText(input.designation, 80),
    department: optText(input.department, 80),
    join_date: input.joinDate ? requireDate(input.joinDate, 'Joining date') : null,
    salary,
    pay_type: payType,
    notes: optText(input.notes, 500)
  }
  if (input.id) {
    getEmployee(ctx, input.id)
    ctx.db
      .prepare('UPDATE employees SET name=@name, phone=@phone, cnic=@cnic, designation=@designation, department=@department, join_date=@join_date, salary=@salary, pay_type=@pay_type, notes=@notes, updated_at=datetime(\'now\',\'localtime\') WHERE id=@id')
      .run({ ...v, id: input.id })
    audit(ctx, 'update', 'employee', input.id, `Edited employee ${name}`)
    return input.id
  }
  return ctx.db.transaction(() => {
    const code = nextNumber(ctx.db, ctx.firmId, 'employee')
    const id = Number(
      ctx.db
        .prepare('INSERT INTO employees (firm_id, code, name, phone, cnic, designation, department, join_date, salary, pay_type, notes, created_by) VALUES (@firm_id, @code, @name, @phone, @cnic, @designation, @department, @join_date, @salary, @pay_type, @notes, @created_by)')
        .run({ ...v, firm_id: ctx.firmId, code, created_by: ctx.user.id }).lastInsertRowid
    )
    audit(ctx, 'create', 'employee', id, `Added employee ${code} ${name}`)
    return id
  })()
}

export function setEmployeeStatus(ctx: Ctx, id: number, input: { status: string; leftDate?: string }): void {
  gate(ctx, 'hr.manage')
  const e = getEmployee(ctx, id)
  const status = input.status === 'left' ? 'left' : 'active'
  ctx.db.prepare('UPDATE employees SET status = ?, left_date = ?, updated_at = datetime(\'now\',\'localtime\') WHERE id = ?').run(status, status === 'left' ? requireDate(input.leftDate ?? today(), 'Leaving date') : null, id)
  audit(ctx, 'status', 'employee', id, `${e.name} marked ${status}`)
}

export function deleteEmployee(ctx: Ctx, id: number): void {
  gate(ctx, 'hr.manage')
  const e = getEmployee(ctx, id)
  const used =
    (ctx.db.prepare('SELECT COUNT(*) AS c FROM attendance WHERE employee_id = ?').get(id) as { c: number }).c +
    (ctx.db.prepare('SELECT COUNT(*) AS c FROM employee_ledger WHERE employee_id = ?').get(id) as { c: number }).c +
    (ctx.db.prepare('SELECT COUNT(*) AS c FROM payroll_lines WHERE employee_id = ?').get(id) as { c: number }).c
  if (used > 0) throw new AppError(`${e.name} has attendance, advances or salary history. Mark the employee as left instead.`, 'VALIDATION')
  ctx.db.prepare('DELETE FROM employees WHERE id = ?').run(id)
  audit(ctx, 'delete', 'employee', id, `Deleted employee ${e.name}`)
}

/* ------------------------------------------------------------------ attendance */

function assertMonthOpen(ctx: Ctx, date: string): void {
  const run = ctx.db.prepare("SELECT status FROM payroll_runs WHERE firm_id = ? AND month = ?").get(ctx.firmId, date.slice(0, 7)) as { status: string } | undefined
  if (run?.status === 'posted') throw new AppError(`The salary of ${date.slice(0, 7)} was already paid. Undo that payment before changing attendance.`, 'VALIDATION')
}

export function attendanceMonth(ctx: Ctx, month: string): Record<string, unknown> {
  gate(ctx, 'hr.view')
  if (!isMonth(month)) throw new AppError('Choose a month.', 'VALIDATION')
  const emps = ctx.db
    .prepare("SELECT * FROM employees WHERE firm_id = ? AND (status = 'active' OR EXISTS (SELECT 1 FROM attendance a WHERE a.employee_id = employees.id AND a.date LIKE ?)) ORDER BY name")
    .all(ctx.firmId, `${month}-%`) as EmployeeRow[]
  const recs = ctx.db.prepare('SELECT employee_id, date, status, overtime_hours, note FROM attendance WHERE date LIKE ?').all(`${month}-%`) as Array<{ employee_id: number; date: string; status: string; overtime_hours: number; note: string | null }>
  return {
    month,
    days: daysInMonth(month),
    employees: emps.map((e) => {
      const mine = recs.filter((r) => r.employee_id === e.id)
      const count = (s: string): number => mine.filter((r) => r.status === s).length
      return {
        id: e.id,
        code: e.code,
        name: e.name,
        pay_type: e.pay_type,
        status: e.status,
        records: Object.fromEntries(mine.map((r) => [r.date, { status: r.status, overtime_hours: r.overtime_hours, note: r.note }])),
        counts: { present: count('present'), absent: count('absent'), leave: count('leave'), half: count('half'), holiday: count('holiday'), overtime: round2(mine.reduce((a, r) => a + r.overtime_hours, 0)) }
      }
    })
  }
}

export function markAttendance(ctx: Ctx, input: { employeeId: number; date: string; status: string | null; overtimeHours?: number; note?: string }): void {
  gate(ctx, 'hr.manage')
  const e = getEmployee(ctx, input.employeeId)
  const date = requireDate(input.date)
  assertMonthOpen(ctx, date)
  if (!input.status) {
    ctx.db.prepare('DELETE FROM attendance WHERE employee_id = ? AND date = ?').run(e.id, date)
    return
  }
  if (!(ATTENDANCE_STATUSES as readonly string[]).includes(input.status)) throw new AppError('Unknown attendance status.', 'VALIDATION')
  const ot = Math.max(0, Math.min(24, round2(num(input.overtimeHours))))
  ctx.db
    .prepare('INSERT INTO attendance (employee_id, date, status, overtime_hours, note) VALUES (?, ?, ?, ?, ?) ON CONFLICT(employee_id, date) DO UPDATE SET status = excluded.status, overtime_hours = excluded.overtime_hours, note = excluded.note')
    .run(e.id, date, input.status, ot, optText(input.note, 200))
}

/** One status for every active employee on one day (for example Present for everyone, then fix the exceptions). */
export function markDay(ctx: Ctx, input: { date: string; status: string; employeeIds?: number[] }): number {
  gate(ctx, 'hr.manage')
  const date = requireDate(input.date)
  assertMonthOpen(ctx, date)
  if (!(ATTENDANCE_STATUSES as readonly string[]).includes(input.status)) throw new AppError('Unknown attendance status.', 'VALIDATION')
  const emps = (ctx.db.prepare("SELECT id FROM employees WHERE firm_id = ? AND status = 'active'").all(ctx.firmId) as Array<{ id: number }>).filter((e) => !input.employeeIds || input.employeeIds.includes(e.id))
  const ins = ctx.db.prepare('INSERT INTO attendance (employee_id, date, status) VALUES (?, ?, ?) ON CONFLICT(employee_id, date) DO UPDATE SET status = excluded.status')
  ctx.db.transaction(() => emps.forEach((e) => ins.run(e.id, date, input.status)))()
  return emps.length
}

/* ------------------------------------------------------------------ advances */

function salaryCategory(ctx: Ctx): number {
  const row = ctx.db.prepare("SELECT id FROM expense_categories WHERE name = 'Salaries' ORDER BY id LIMIT 1").get() as { id: number } | undefined
  if (row) return row.id
  return Number(ctx.db.prepare("INSERT INTO expense_categories (name, cost_head) VALUES ('Salaries', 'overhead')").run().lastInsertRowid)
}

export function giveAdvance(ctx: Ctx, input: { employeeId: number; date?: string; amount: number; accountId: number; notes?: string }): number {
  gate(ctx, 'hr.manage')
  const e = getEmployee(ctx, input.employeeId)
  const amount = round2(num(input.amount))
  if (amount <= 0) throw new AppError('Enter the advance amount.', 'VALIDATION')
  const date = requireDate(input.date ?? today())
  const accountId = assertAccount(ctx, input.accountId)
  return ctx.db.transaction(() => {
    const expenseId = insertExpense(ctx, { date, categoryId: salaryCategory(ctx), amount, paid: true, accountId, payeeName: e.name, notes: `Salary advance to ${e.name}${input.notes ? `: ${input.notes}` : ''}` })
    const id = Number(
      ctx.db.prepare("INSERT INTO employee_ledger (firm_id, employee_id, date, kind, amount, notes, expense_id, created_by) VALUES (?, ?, ?, 'advance', ?, ?, ?, ?)").run(ctx.firmId, e.id, date, amount, optText(input.notes, 200), expenseId, ctx.user.id).lastInsertRowid
    )
    audit(ctx, 'create', 'employee_advance', id, `Advance of ${amount} to ${e.name}`)
    return id
  })()
}

/* ------------------------------------------------------------------ payroll */

interface RunRow {
  id: number
  firm_id: number
  month: string
  status: string
  account_id: number | null
}
interface LineRow {
  id: number
  run_id: number
  employee_id: number
  base: number
  paid_days: number
  absent_days: number
  overtime_hours: number
  overtime_pay: number
  bonus: number
  deductions: number
  advance_recovery: number
  net: number
  expense_id: number | null
  notes: string | null
}

function getRun(ctx: Ctx, id: number): RunRow {
  const r = ctx.db.prepare('SELECT * FROM payroll_runs WHERE id = ? AND firm_id = ?').get(id, ctx.firmId) as RunRow | undefined
  if (!r) throw new AppError('Salary sheet not found.', 'NOT_FOUND')
  return r
}

const netOf = (l: { base: number; overtime_pay: number; bonus: number; deductions: number; advance_recovery: number }): number => round2(l.base + l.overtime_pay + l.bonus - l.deductions - l.advance_recovery)

/** Makes (or refreshes) the draft salary sheet of a month from the attendance. Manual bonus, deductions and recovery are kept. */
export function preparePayroll(ctx: Ctx, month: string): number {
  gate(ctx, 'hr.payroll')
  if (!isMonth(month)) throw new AppError('Choose a month.', 'VALIDATION')
  const db = ctx.db
  return db.transaction(() => {
    let run = db.prepare('SELECT * FROM payroll_runs WHERE firm_id = ? AND month = ?').get(ctx.firmId, month) as RunRow | undefined
    if (run?.status === 'posted') throw new AppError(`The salary of ${month} is already paid. Undo the payment to change it.`, 'VALIDATION')
    if (!run) {
      const id = Number(db.prepare('INSERT INTO payroll_runs (firm_id, month, created_by) VALUES (?, ?, ?)').run(ctx.firmId, month, ctx.user.id).lastInsertRowid)
      run = db.prepare('SELECT * FROM payroll_runs WHERE id = ?').get(id) as RunRow
      audit(ctx, 'create', 'payroll_run', id, `Prepared the salary sheet of ${month}`)
    }
    const last = `${month}-${String(daysInMonth(month)).padStart(2, '0')}`
    const emps = db
      .prepare("SELECT * FROM employees WHERE firm_id = ? AND (status = 'active' OR left_date >= ?) AND (join_date IS NULL OR join_date <= ?) ORDER BY name")
      .all(ctx.firmId, `${month}-01`, last) as EmployeeRow[]
    for (const e of emps) {
      const rows = db.prepare('SELECT status, overtime_hours FROM attendance WHERE employee_id = ? AND date LIKE ?').all(e.id, `${month}-%`) as Array<{ status: string; overtime_hours: number }>
      const count = (s: string): number => rows.filter((r) => r.status === s).length
      const ot = round2(rows.reduce((a, r) => a + r.overtime_hours, 0))
      const pay = computeSalary({ payType: e.pay_type, salary: e.salary, daysInMonth: daysInMonth(month), present: count('present'), absent: count('absent'), half: count('half'), leave: count('leave'), holiday: count('holiday'), overtimeHours: ot })
      const existing = db.prepare('SELECT * FROM payroll_lines WHERE run_id = ? AND employee_id = ?').get(run.id, e.id) as LineRow | undefined
      if (existing) {
        const line = { base: pay.base, overtime_pay: pay.overtimePay, bonus: existing.bonus, deductions: existing.deductions, advance_recovery: existing.advance_recovery }
        db.prepare('UPDATE payroll_lines SET base = ?, paid_days = ?, absent_days = ?, overtime_hours = ?, overtime_pay = ?, net = ? WHERE id = ?').run(pay.base, pay.paidDays, pay.absentDays, ot, pay.overtimePay, netOf(line), existing.id)
      } else {
        const gross = round2(pay.base + pay.overtimePay)
        const recovery = Math.min(advanceBalance(db, e.id), Math.max(0, gross))
        db.prepare('INSERT INTO payroll_lines (run_id, employee_id, base, paid_days, absent_days, overtime_hours, overtime_pay, advance_recovery, net) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(run.id, e.id, pay.base, pay.paidDays, pay.absentDays, ot, pay.overtimePay, recovery, round2(gross - recovery))
      }
    }
    return run.id
  })()
}

export function getPayroll(ctx: Ctx, id: number): Record<string, unknown> {
  gate(ctx, 'hr.view')
  const run = getRun(ctx, id)
  const lines = ctx.db
    .prepare('SELECT l.*, e.code, e.name, e.designation, e.pay_type, e.salary FROM payroll_lines l JOIN employees e ON e.id = l.employee_id WHERE l.run_id = ? ORDER BY e.name')
    .all(id) as Array<LineRow & { employee_id: number }>
  const totals = lines.reduce(
    (a, l) => ({ base: a.base + l.base, overtime: a.overtime + l.overtime_pay, bonus: a.bonus + l.bonus, deductions: a.deductions + l.deductions, recovery: a.recovery + l.advance_recovery, net: a.net + l.net }),
    { base: 0, overtime: 0, bonus: 0, deductions: 0, recovery: 0, net: 0 }
  )
  return { run, lines: lines.map((l) => ({ ...l, advance_balance: advanceBalance(ctx.db, l.employee_id) })), totals: Object.fromEntries(Object.entries(totals).map(([k, v]) => [k, round2(v)])) }
}

export function listPayrolls(ctx: Ctx): unknown[] {
  gate(ctx, 'hr.view')
  return ctx.db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM payroll_lines l WHERE l.run_id = r.id) AS employees, (SELECT COALESCE(SUM(net), 0) FROM payroll_lines l WHERE l.run_id = r.id) AS net_total
         FROM payroll_runs r WHERE r.firm_id = ? ORDER BY r.month DESC LIMIT 36`
    )
    .all(ctx.firmId)
}

export function updatePayrollLine(ctx: Ctx, lineId: number, input: { bonus?: number; deductions?: number; advanceRecovery?: number; notes?: string }): void {
  gate(ctx, 'hr.payroll')
  const l = ctx.db.prepare('SELECT l.*, r.status AS run_status, r.firm_id FROM payroll_lines l JOIN payroll_runs r ON r.id = l.run_id WHERE l.id = ?').get(lineId) as (LineRow & { run_status: string; firm_id: number }) | undefined
  if (!l || l.firm_id !== ctx.firmId) throw new AppError('Salary line not found.', 'NOT_FOUND')
  if (l.run_status === 'posted') throw new AppError('This salary sheet is already paid.', 'VALIDATION')
  const bonus = round2(Math.max(0, num(input.bonus ?? l.bonus)))
  const deductions = round2(Math.max(0, num(input.deductions ?? l.deductions)))
  const recovery = round2(Math.max(0, num(input.advanceRecovery ?? l.advance_recovery)))
  const balance = advanceBalance(ctx.db, l.employee_id)
  if (recovery > balance + 0.005) throw new AppError(`Only ${balance} of advance is still to be taken back from this employee.`, 'VALIDATION')
  const net = netOf({ base: l.base, overtime_pay: l.overtime_pay, bonus, deductions, advance_recovery: recovery })
  if (net < 0) throw new AppError('The pay after deductions would be below zero. Take back less of the advance or reduce the deductions.', 'VALIDATION')
  ctx.db.prepare('UPDATE payroll_lines SET bonus = ?, deductions = ?, advance_recovery = ?, net = ?, notes = ? WHERE id = ?').run(bonus, deductions, recovery, net, input.notes === undefined ? l.notes : optText(input.notes, 200), lineId)
}

/** Pays the sheet: one expense per employee from the chosen account, advances taken back. */
export function postPayroll(ctx: Ctx, id: number, input: { accountId: number; date?: string }): void {
  gate(ctx, 'hr.payroll')
  const run = getRun(ctx, id)
  if (run.status === 'posted') throw new AppError('This salary sheet is already paid.', 'VALIDATION')
  const lines = ctx.db.prepare('SELECT l.*, e.name FROM payroll_lines l JOIN employees e ON e.id = l.employee_id WHERE l.run_id = ?').all(id) as Array<LineRow & { name: string }>
  if (!lines.length) throw new AppError('The salary sheet has no employees.', 'VALIDATION')
  const accountId = assertAccount(ctx, input.accountId)
  const date = requireDate(input.date ?? today())
  const category = salaryCategory(ctx)
  ctx.db.transaction(() => {
    let total = 0
    for (const l of lines) {
      let expenseId: number | null = null
      if (l.net > 0) {
        expenseId = insertExpense(ctx, { date, categoryId: category, amount: l.net, paid: true, accountId, payeeName: l.name, notes: `Salary ${run.month} - ${l.name}` })
        total += l.net
      }
      if (l.advance_recovery > 0) {
        ctx.db.prepare("INSERT INTO employee_ledger (firm_id, employee_id, date, kind, amount, notes, run_id, created_by) VALUES (?, ?, ?, 'recovery', ?, ?, ?, ?)").run(ctx.firmId, l.employee_id, date, l.advance_recovery, `Taken back from the salary of ${run.month}`, id, ctx.user.id)
      }
      ctx.db.prepare('UPDATE payroll_lines SET expense_id = ? WHERE id = ?').run(expenseId, l.id)
    }
    ctx.db.prepare("UPDATE payroll_runs SET status = 'posted', account_id = ?, posted_at = datetime('now','localtime'), posted_by = ? WHERE id = ?").run(accountId, ctx.user.id, id)
    audit(ctx, 'update', 'payroll_run', id, `Paid the salary of ${run.month}: ${round2(total)} to ${lines.filter((l) => l.net > 0).length} employee(s)`)
  })()
}

/** Takes a paid salary sheet back to draft: the expenses are cancelled and the advances are owed again. */
export function undoPayroll(ctx: Ctx, id: number): void {
  gate(ctx, 'hr.payroll')
  const run = getRun(ctx, id)
  if (run.status !== 'posted') throw new AppError('This salary sheet is not paid.', 'VALIDATION')
  const lines = ctx.db.prepare('SELECT id, expense_id FROM payroll_lines WHERE run_id = ?').all(id) as Array<{ id: number; expense_id: number | null }>
  ctx.db.transaction(() => {
    for (const l of lines) if (l.expense_id) voidExpense(ctx, l.expense_id, `Salary sheet ${run.month} taken back`)
    ctx.db.prepare('UPDATE payroll_lines SET expense_id = NULL WHERE run_id = ?').run(id)
    ctx.db.prepare("DELETE FROM employee_ledger WHERE run_id = ? AND kind = 'recovery'").run(id)
    ctx.db.prepare("UPDATE payroll_runs SET status = 'draft', account_id = NULL, posted_at = NULL, posted_by = NULL WHERE id = ?").run(id)
    audit(ctx, 'update', 'payroll_run', id, `Took back the payment of the salary of ${run.month}`)
  })()
}

export function deletePayrollDraft(ctx: Ctx, id: number): void {
  gate(ctx, 'hr.payroll')
  const run = getRun(ctx, id)
  if (run.status === 'posted') throw new AppError('Undo the payment first.', 'VALIDATION')
  ctx.db.transaction(() => {
    ctx.db.prepare('DELETE FROM payroll_lines WHERE run_id = ?').run(id)
    ctx.db.prepare('DELETE FROM payroll_runs WHERE id = ?').run(id)
  })()
  audit(ctx, 'delete', 'payroll_run', id, `Deleted the draft salary sheet of ${run.month}`)
}

/** HR and payroll: salary maths, employees, attendance, advances, the monthly salary sheet and its payment. Real services on a real SQLite database. */
import { describe, expect, it } from 'vitest'
import { computeSalary, daysInMonth, isMonth } from '../src/shared/payroll'
import { updateSettings } from '../src/main/services/settings'
import { accountBalance } from '../src/main/services/payments'
import {
  advanceBalance, attendanceMonth, deleteEmployee, deletePayrollDraft, getEmployeeDetail, getPayroll, giveAdvance, listEmployees, listPayrolls, markAttendance, markDay,
  postPayroll, preparePayroll, saveEmployee, setEmployeeStatus, undoPayroll, updatePayrollLine
} from '../src/main/services/hr'
import { cashAccount, setupCtx, userCtx } from './helpers'

const base = { daysInMonth: 30, present: 0, absent: 0, half: 0, leave: 0, holiday: 0, overtimeHours: 0 }

describe('salary maths', () => {
  it('monthly pay loses one day of pay for each absent day and half for a half day; unmarked days count as worked', () => {
    expect(computeSalary({ ...base, payType: 'monthly', salary: 30000 })).toEqual({ paidDays: 30, absentDays: 0, base: 30000, overtimePay: 0 })
    expect(computeSalary({ ...base, payType: 'monthly', salary: 30000, absent: 2 })).toMatchObject({ paidDays: 28, absentDays: 2, base: 28000 })
    expect(computeSalary({ ...base, payType: 'monthly', salary: 30000, absent: 1, half: 1 })).toMatchObject({ absentDays: 1.5, base: 28500 })
    expect(computeSalary({ ...base, payType: 'monthly', salary: 30000, present: 20, leave: 3, holiday: 2 }).base).toBe(30000)
    expect(computeSalary({ ...base, payType: 'monthly', salary: 30000, absent: 40 }).base).toBe(0)
  })

  it('daily pay is the daily rate for the days present, half days, paid leave and holidays', () => {
    expect(computeSalary({ ...base, payType: 'daily', salary: 1500, present: 20, half: 2, leave: 1, holiday: 2 })).toMatchObject({ paidDays: 24, base: 36000 })
    expect(computeSalary({ ...base, payType: 'daily', salary: 1500 }).base).toBe(0)
  })

  it('overtime is hours at the hourly rate times 1.5', () => {
    expect(computeSalary({ ...base, payType: 'monthly', salary: 30000, overtimeHours: 4 }).overtimePay).toBe(750) // 1000 a day, 125 an hour
    expect(computeSalary({ ...base, payType: 'daily', salary: 1600, overtimeHours: 2 }).overtimePay).toBe(600) // 200 an hour
  })

  it('knows months', () => {
    expect(isMonth('2026-02')).toBe(true)
    expect(isMonth('2026-13')).toBe(false)
    expect(isMonth('2026-2')).toBe(false)
    expect(daysInMonth('2028-02')).toBe(29)
    expect(daysInMonth('2026-10')).toBe(31)
  })
})

function office() {
  const ctx = setupCtx()
  updateSettings(ctx, { erp_modules: { hr: true } })
  const ali = saveEmployee(ctx, { name: 'Ali Raza', designation: 'Salesman', salary: 31000, payType: 'monthly', joinDate: '2025-01-01' })
  const bilal = saveEmployee(ctx, { name: 'Bilal Ahmed', designation: 'Electrician', salary: 1500, payType: 'daily', joinDate: '2025-01-01' })
  return { ctx, ali, bilal, acc: cashAccount(ctx) }
}
const MONTH = '2026-03' // 31 days

describe('employees and attendance', () => {
  it('is off until the module is switched on', () => {
    const ctx = setupCtx()
    expect(() => listEmployees(ctx)).toThrow(/switched off/)
  })

  it('numbers employees, validates, marks them left and deletes only an employee with no history', () => {
    const { ctx, ali, bilal } = office()
    expect((listEmployees(ctx) as Array<Record<string, any>>).map((e) => e.code)).toEqual(['EMP-00001', 'EMP-00002'])
    expect(() => saveEmployee(ctx, { name: ' ', salary: 1 })).toThrow(/Name is required/)
    expect(() => saveEmployee(ctx, { name: 'X', salary: -1 })).toThrow(/cannot be negative/)
    saveEmployee(ctx, { id: ali, name: 'Ali Raza', salary: 32000 })
    expect((getEmployeeDetail(ctx, ali).employee as Record<string, any>).salary).toBe(32000)
    const spare = saveEmployee(ctx, { name: 'Temp', salary: 100 })
    deleteEmployee(ctx, spare)
    markAttendance(ctx, { employeeId: bilal, date: '2026-03-02', status: 'present' })
    expect(() => deleteEmployee(ctx, bilal)).toThrow(/Mark the employee as left/)
    setEmployeeStatus(ctx, bilal, { status: 'left', leftDate: '2026-03-31' })
    expect((listEmployees(ctx, { status: 'left' }) as unknown[]).length).toBe(1)
  })

  it('marks and clears attendance, marks a whole day, and counts the month', () => {
    const { ctx, ali, bilal } = office()
    expect(markDay(ctx, { date: '2026-03-02', status: 'present' })).toBe(2)
    markAttendance(ctx, { employeeId: ali, date: '2026-03-03', status: 'absent' })
    markAttendance(ctx, { employeeId: ali, date: '2026-03-04', status: 'half' })
    markAttendance(ctx, { employeeId: bilal, date: '2026-03-04', status: 'present', overtimeHours: 3.5, note: 'Site job' })
    markAttendance(ctx, { employeeId: bilal, date: '2026-03-02', status: null })
    const m = attendanceMonth(ctx, MONTH) as { days: number; employees: Array<Record<string, any>> }
    expect(m.days).toBe(31)
    const a = m.employees.find((e) => e.id === ali)!
    const b = m.employees.find((e) => e.id === bilal)!
    expect(a.counts).toMatchObject({ present: 1, absent: 1, half: 1 })
    expect(b.counts).toMatchObject({ present: 1, overtime: 3.5 })
    expect(b.records['2026-03-04']).toEqual({ status: 'present', overtime_hours: 3.5, note: 'Site job' })
    expect(() => markAttendance(ctx, { employeeId: ali, date: '2026-03-05', status: 'late' })).toThrow(/Unknown attendance status/)
    expect(() => attendanceMonth(ctx, 'March')).toThrow(/Choose a month/)
  })
})

describe('advances and the salary sheet', () => {
  it('an advance is paid out and booked as an expense, and is owed until the salary sheet takes it back', () => {
    const { ctx, ali, acc } = office()
    const before = accountBalance(ctx.db, acc)
    giveAdvance(ctx, { employeeId: ali, date: '2026-03-10', amount: 5000, accountId: acc, notes: 'Eid' })
    expect(accountBalance(ctx.db, acc)).toBe(before - 5000)
    expect(advanceBalance(ctx.db, ali)).toBe(5000)
    expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM expenses e JOIN expense_categories c ON c.id = e.category_id WHERE c.name = 'Salaries' AND e.paid = 1").get()).toEqual({ c: 1 })
    expect(() => giveAdvance(ctx, { employeeId: ali, amount: 0, accountId: acc })).toThrow(/Enter the advance amount/)
    expect((listEmployees(ctx) as Array<Record<string, any>>).find((e) => e.id === ali)!.advance_balance).toBe(5000)
  })

  it('prepares the sheet from attendance, keeps manual edits, pays one expense per employee and takes the advance back', () => {
    const { ctx, ali, bilal, acc } = office()
    giveAdvance(ctx, { employeeId: ali, date: '2026-03-10', amount: 5000, accountId: acc })
    for (let d = 1; d <= 20; d++) markAttendance(ctx, { employeeId: bilal, date: `2026-03-${String(d).padStart(2, '0')}`, status: 'present', overtimeHours: d === 5 ? 2 : 0 })
    markAttendance(ctx, { employeeId: ali, date: '2026-03-03', status: 'absent' })
    const id = preparePayroll(ctx, MONTH)
    let p = getPayroll(ctx, id) as { run: Record<string, any>; lines: Array<Record<string, any>>; totals: Record<string, number> }
    const la = p.lines.find((l) => l.employee_id === ali)!
    const lb = p.lines.find((l) => l.employee_id === bilal)!
    // Ali: 31000 a month over 31 days = 1000 a day, one absent day; Bilal: 20 days at 1500 and two overtime hours (187.5 x 1.5 x 2)
    expect(la).toMatchObject({ base: 30000, advance_recovery: 5000, net: 25000, absent_days: 1 })
    expect(lb).toMatchObject({ base: 30000, overtime_hours: 2, overtime_pay: 562.5, advance_recovery: 0, net: 30562.5 })
    expect(p.run).toMatchObject({ month: MONTH, status: 'draft' })

    updatePayrollLine(ctx, la.id, { bonus: 2000, deductions: 500, advanceRecovery: 3000, notes: 'Sales target bonus' })
    expect(() => updatePayrollLine(ctx, la.id, { advanceRecovery: 9000 })).toThrow(/Only 5000 of advance/)
    expect(() => updatePayrollLine(ctx, la.id, { deductions: 90000, advanceRecovery: 0 })).toThrow(/below zero/)
    preparePayroll(ctx, MONTH) // refresh keeps the manual numbers
    p = getPayroll(ctx, id) as typeof p
    expect(p.lines.find((l) => l.employee_id === ali)).toMatchObject({ bonus: 2000, deductions: 500, advance_recovery: 3000, net: 28500, notes: 'Sales target bonus' })

    const before = accountBalance(ctx.db, acc)
    postPayroll(ctx, id, { accountId: acc, date: '2026-03-31' })
    expect(accountBalance(ctx.db, acc)).toBe(before - 28500 - 30562.5)
    expect(advanceBalance(ctx.db, ali)).toBe(2000)
    p = getPayroll(ctx, id) as typeof p
    expect(p.run.status).toBe('posted')
    expect(ctx.db.prepare("SELECT payee_name, amount, paid, notes FROM expenses WHERE notes LIKE 'Salary 2026-03%' ORDER BY id").all()).toEqual([
      { payee_name: 'Ali Raza', amount: 28500, paid: 1, notes: 'Salary 2026-03 - Ali Raza' },
      { payee_name: 'Bilal Ahmed', amount: 30562.5, paid: 1, notes: 'Salary 2026-03 - Bilal Ahmed' }
    ])
    // a paid month is locked
    expect(() => postPayroll(ctx, id, { accountId: acc })).toThrow(/already paid/)
    expect(() => preparePayroll(ctx, MONTH)).toThrow(/already paid/)
    expect(() => updatePayrollLine(ctx, la.id, { bonus: 1 })).toThrow(/already paid/)
    expect(() => markAttendance(ctx, { employeeId: ali, date: '2026-03-09', status: 'absent' })).toThrow(/already paid/)
    expect(() => deletePayrollDraft(ctx, id)).toThrow(/Undo the payment/)
    expect((listPayrolls(ctx) as Array<Record<string, any>>)[0]).toMatchObject({ month: MONTH, status: 'posted', employees: 2, net_total: 59062.5 })

    // take the payment back: expenses cancelled, the advance is owed again, the sheet is a draft
    undoPayroll(ctx, id)
    expect(accountBalance(ctx.db, acc)).toBe(before)
    expect(advanceBalance(ctx.db, ali)).toBe(5000)
    expect((getPayroll(ctx, id) as typeof p).run.status).toBe('draft')
    expect(ctx.db.prepare("SELECT COUNT(*) AS c FROM expenses WHERE notes LIKE 'Salary 2026-03%' AND status = 'cancelled'").get()).toEqual({ c: 2 })
    markAttendance(ctx, { employeeId: ali, date: '2026-03-09', status: 'absent' })
    deletePayrollDraft(ctx, id)
    expect((listPayrolls(ctx) as unknown[]).length).toBe(0)
  })

  it('an employee who joined later or left earlier is left out of the month', () => {
    const { ctx, ali } = office()
    const late = saveEmployee(ctx, { name: 'New Joiner', salary: 20000, joinDate: '2026-04-10' })
    const gone = saveEmployee(ctx, { name: 'Left Earlier', salary: 20000, joinDate: '2025-01-01' })
    setEmployeeStatus(ctx, gone, { status: 'left', leftDate: '2026-02-20' })
    const id = preparePayroll(ctx, MONTH)
    const names = (getPayroll(ctx, id) as { lines: Array<Record<string, any>> }).lines.map((l) => l.employee_id)
    expect(names).toContain(ali)
    expect(names).not.toContain(late)
    expect(names).not.toContain(gone)
  })
})

describe('HR permissions', () => {
  it('an Accountant can prepare and pay the salary sheet and see employees but not add them; a Salesperson sees nothing', () => {
    const { ctx, acc } = office()
    const accountant = userCtx(ctx, 'Accountant', 'acct1')
    expect((listEmployees(accountant) as unknown[]).length).toBe(2)
    expect(() => saveEmployee(accountant, { name: 'Nope', salary: 1 })).toThrow(/permission/i)
    const id = preparePayroll(accountant, MONTH)
    postPayroll(accountant, id, { accountId: acc })
    expect(() => listEmployees(userCtx(ctx, 'Salesperson', 'sales1'))).toThrow(/permission/i)
  })
})

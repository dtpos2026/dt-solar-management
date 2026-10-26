/**
 * Salary rules (pure, so the screen and the tests use the same maths).
 *  - Monthly pay: the full salary is paid; every ABSENT day takes away one day of pay (salary / days in the month) and a half day
 *    takes away half a day. A day with no attendance mark counts as worked, so a shop that does not keep attendance pays the full salary.
 *  - Daily pay: only the days marked present, half (half a day), paid leave and holiday are paid at the daily rate.
 *  - Overtime: hours x the hourly rate (day rate / 8) x 1.5.
 */
export const ATTENDANCE_STATUSES = ['present', 'absent', 'leave', 'half', 'holiday'] as const
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number]
export const OVERTIME_MULTIPLIER = 1.5
export const HOURS_PER_DAY = 8

export interface SalaryInput {
  payType: 'monthly' | 'daily'
  salary: number
  daysInMonth: number
  present: number
  absent: number
  half: number
  leave: number
  holiday: number
  overtimeHours: number
}
export interface SalaryResult {
  paidDays: number
  absentDays: number
  base: number
  overtimePay: number
}

const r2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100

export function computeSalary(i: SalaryInput): SalaryResult {
  const dayRate = i.payType === 'daily' ? i.salary : i.salary / Math.max(1, i.daysInMonth)
  let base: number
  let paidDays: number
  let absentDays: number
  if (i.payType === 'daily') {
    paidDays = i.present + i.half * 0.5 + i.leave + i.holiday
    absentDays = i.absent + i.half * 0.5
    base = dayRate * paidDays
  } else {
    absentDays = i.absent + i.half * 0.5
    paidDays = Math.max(0, i.daysInMonth - absentDays)
    base = Math.max(0, i.salary - dayRate * absentDays)
  }
  const overtimePay = (dayRate / HOURS_PER_DAY) * OVERTIME_MULTIPLIER * Math.max(0, i.overtimeHours)
  return { paidDays: r2(paidDays), absentDays: r2(absentDays), base: r2(base), overtimePay: r2(overtimePay) }
}

export const isMonth = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s)

export function daysInMonth(month: string): number {
  const [y, m] = month.split('-').map(Number)
  return new Date(y, m, 0).getDate()
}

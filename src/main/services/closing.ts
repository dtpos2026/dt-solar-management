/**
 * Day / month closing (owner: data area). Shared helper: assertPeriodOpen is called by every service that
 * creates, edits, cancels or deletes a dated transaction, so closed periods stay unchanged.
 */
import type { DB } from '../db'
import { AppError } from './context'

/** Throws when `date` (YYYY-MM-DD) falls in a closed day or month of the firm. */
export function assertPeriodOpen(db: DB, firmId: number, date: string): void {
  const row = db
    .prepare(
      `SELECT kind, period_start, period_end FROM day_closings
       WHERE firm_id = ? AND status = 'closed' AND ? BETWEEN period_start AND period_end
       ORDER BY kind = 'month' DESC LIMIT 1`
    )
    .get(firmId, date) as { kind: string; period_start: string; period_end: string } | undefined
  if (row) {
    const what = row.kind === 'month' ? `month ${row.period_start.slice(0, 7)}` : `day ${row.period_start}`
    throw new AppError(`The ${what} is closed. Ask an authorised user to reopen it before changing transactions dated ${date}.`, 'PERIOD_CLOSED')
  }
}

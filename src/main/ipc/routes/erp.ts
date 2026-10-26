/** IPC routes - ERP modules: cheques, service and warranty, HR and payroll, reorder planning, barcode labels. Rules live in the services. */
import type { RouteMap } from '../common'
import * as cheques from '../../services/cheques'
import * as service from '../../services/service'
import * as hr from '../../services/hr'
import * as reorder from '../../services/reorder'
import * as inv from '../../services/inventory'

export const erpRoutes: RouteMap = {
  'cheques.list': { handler: (c, a) => cheques.listCheques(c.ctx, a as never) },
  'cheques.summary': { handler: (c) => cheques.chequeSummary(c.ctx) },
  'cheques.alerts': { handler: (c) => cheques.chequeAlerts(c.ctx) },
  'cheques.save': { write: true, handler: (c, a) => cheques.saveCheque(c.ctx, a as never) },
  'cheques.status': { write: true, handler: (c, a) => cheques.setChequeStatus(c.ctx, Number(a.id), a as never) },
  'cheques.delete': { write: true, handler: (c, a) => cheques.deleteCheque(c.ctx, Number(a.id)) },

  'service.list': { handler: (c, a) => service.listTickets(c.ctx, a as never) },
  'service.get': { handler: (c, a) => service.getTicket(c.ctx, Number(a.id)) },
  'service.summary': { handler: (c) => service.ticketSummary(c.ctx) },
  'service.warranty': { handler: (c, a) => service.warrantyCheck(c.ctx, a as never) },
  'service.save': { write: true, handler: (c, a) => service.saveTicket(c.ctx, a as never) },
  'service.activity': { write: true, handler: (c, a) => service.addActivity(c.ctx, Number(a.id), a as never) },
  'service.status': { write: true, handler: (c, a) => service.setTicketStatus(c.ctx, Number(a.id), a as never) },
  'service.delete': { write: true, handler: (c, a) => service.deleteTicket(c.ctx, Number(a.id)) },

  'hr.employees': { handler: (c, a) => hr.listEmployees(c.ctx, a as never) },
  'hr.employee': { handler: (c, a) => hr.getEmployeeDetail(c.ctx, Number(a.id)) },
  'hr.saveEmployee': { write: true, handler: (c, a) => hr.saveEmployee(c.ctx, a as never) },
  'hr.employeeStatus': { write: true, handler: (c, a) => hr.setEmployeeStatus(c.ctx, Number(a.id), a as never) },
  'hr.deleteEmployee': { write: true, handler: (c, a) => hr.deleteEmployee(c.ctx, Number(a.id)) },
  'hr.attendance': { handler: (c, a) => hr.attendanceMonth(c.ctx, String(a.month)) },
  'hr.mark': { write: true, handler: (c, a) => hr.markAttendance(c.ctx, a as never) },
  'hr.markDay': { write: true, handler: (c, a) => hr.markDay(c.ctx, a as never) },
  'hr.advance': { write: true, handler: (c, a) => hr.giveAdvance(c.ctx, a as never) },
  'hr.payrolls': { handler: (c) => hr.listPayrolls(c.ctx) },
  'hr.preparePayroll': { write: true, handler: (c, a) => hr.preparePayroll(c.ctx, String(a.month)) },
  'hr.payroll': { handler: (c, a) => hr.getPayroll(c.ctx, Number(a.id)) },
  'hr.updateLine': { write: true, handler: (c, a) => hr.updatePayrollLine(c.ctx, Number(a.lineId), a as never) },
  'hr.postPayroll': { write: true, handler: (c, a) => hr.postPayroll(c.ctx, Number(a.id), a as never) },
  'hr.undoPayroll': { write: true, handler: (c, a) => hr.undoPayroll(c.ctx, Number(a.id)) },
  'hr.deletePayroll': { write: true, handler: (c, a) => hr.deletePayrollDraft(c.ctx, Number(a.id)) },

  'reorder.suggestions': { handler: (c, a) => reorder.suggestions(c.ctx, a as never) },
  'reorder.createOrders': { write: true, handler: (c, a) => reorder.createOrders(c.ctx, a as never) },
  'products.assignBarcodes': { write: true, handler: (c, a) => inv.assignBarcodes(c.ctx, (a.ids as number[]) ?? []) }
}

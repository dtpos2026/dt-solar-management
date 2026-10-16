/**
 * Firestore access for invoices, payments, public verification copies and billing settings.
 * Totals always come from lib/billing.ts. Invoices are cancelled; a cancelled (or unpaid) invoice may be deleted with its
 * payments and public copy (deleteInvoice). Payments are append-only (voided, never edited).
 */
import {
  Timestamp, collection, doc, getDocs, orderBy, query, runTransaction, serverTimestamp, updateDoc, writeBatch,
  type DocumentData, type DocumentSnapshot, type QueryDocumentSnapshot, type Transaction
} from 'firebase/firestore'
import { db } from '../firebase'
import { licenseRef } from './licenses'
import { writeActivity } from './audit'
import { loadBranding as loadBrandingDoc } from './brandingStore'
import { invalidate } from './queryCache'
import { applyPayment, computeTotals, formatNumber, makeToken, publicCustomerName, rebalance, round2, voidPayment, type LineInput } from './billing'
import type { Branding, Client, Invoice, InvoicePayment, PlanType } from './types'

type Snap = DocumentSnapshot<DocumentData> | QueryDocumentSnapshot<DocumentData>
const s = (v: unknown, d = ''): string => (typeof v === 'string' ? v : v == null ? d : String(v))
const n = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
const ts = (v: unknown): Timestamp | null => (v instanceof Timestamp ? v : null)

export const invoicesCol = () => collection(db, 'invoices')
export const invoiceRef = (id: string) => doc(db, 'invoices', id)
export const paymentsCol = (id: string) => collection(db, 'invoices', id, 'payments')
export const publicInvoiceRef = (token: string) => doc(db, 'publicInvoices', token)

export function invoiceFromSnap(x: Snap): Invoice {
  const d = x.data() ?? {}
  return {
    id: x.id, number: s(d.number), clientId: s(d.clientId), clientName: s(d.clientName), licenseId: s(d.licenseId),
    planType: s(d.planType) as PlanType | '', issueDate: ts(d.issueDate), dueDate: ts(d.dueDate), currency: s(d.currency, 'PKR'),
    lines: Array.isArray(d.lines) ? d.lines.map((l: DocumentData) => ({ kind: l.kind ?? 'other', description: s(l.description), qty: n(l.qty), rate: n(l.rate), amount: n(l.amount) })) : [],
    subtotal: n(d.subtotal), discount: n(d.discount), taxRate: n(d.taxRate), taxAmount: n(d.taxAmount), total: n(d.total),
    paid: n(d.paid), balance: n(d.balance), status: s(d.status, 'unpaid') as Invoice['status'], verifyToken: s(d.verifyToken),
    notes: s(d.notes), createdAt: ts(d.createdAt), createdBy: s(d.createdBy), updatedAt: ts(d.updatedAt),
    cancelledAt: ts(d.cancelledAt), cancelReason: s(d.cancelReason), lastPaymentAt: ts(d.lastPaymentAt)
  }
}

export function paymentFromSnap(x: Snap): InvoicePayment {
  const d = x.data() ?? {}
  return { id: x.id, amount: n(d.amount), method: s(d.method), reference: s(d.reference), date: ts(d.date), receiptNo: s(d.receiptNo), createdAt: ts(d.createdAt), createdBy: s(d.createdBy), cancelled: d.cancelled === true, cancelReason: s(d.cancelReason) }
}

export function clientFromSnap(x: Snap): Client {
  return { id: x.id, ...(x.data() ?? {}) } as Client
}

export const loadBranding = (): Promise<Branding> => loadBrandingDoc()

export async function loadPayments(invoiceId: string): Promise<InvoicePayment[]> {
  const r = await getDocs(query(paymentsCol(invoiceId), orderBy('createdAt', 'asc')))
  return r.docs.map(paymentFromSnap)
}

function txAudit(tx: Transaction, action: string, _by: string, target: string, details: string, licenseId: string | null, meta: Record<string, unknown> = {}) {
  writeActivity(tx, { action, category: 'financial', target, targetType: 'invoice', licenseId: licenseId || null, details, meta })
}

function newToken(): string {
  return makeToken((k) => crypto.getRandomValues(new Uint8Array(k)))
}

function publicStatus(paid: number, total: number): 'paid' | 'partial' | 'unpaid' {
  return paid <= 0 ? 'unpaid' : paid >= total - 0.001 ? 'paid' : 'partial'
}

interface PublicSource {
  number: string
  clientName: string
  issueDate: Timestamp | null
  dueDate: Timestamp | null
  currency: string
  total: number
  paid: number
  lines: { description: string; qty: number; amount: number }[]
}

function publicCopy(inv: PublicSource, b: Branding, cancelled = false) {
  return {
    number: inv.number, issuerName: b.companyName, issuerPhone: b.phone, issuerEmail: b.email, issuerAddress: b.address, issuerLogo: b.logo ?? null,
    customerName: publicCustomerName(inv.clientName, b.customerPrivacy), issueDate: inv.issueDate, dueDate: inv.dueDate, currency: inv.currency,
    total: inv.total, paymentStatus: publicStatus(inv.paid, inv.total), status: cancelled ? 'cancelled' : 'valid',
    lines: inv.lines.map((l) => ({ description: l.description, qty: l.qty, amount: l.amount })), updatedAt: serverTimestamp()
  }
}

export interface InvoiceInput {
  clientId: string
  clientName: string
  licenseId: string
  planType: PlanType | ''
  lines: LineInput[]
  discount: number
  taxRate: number
  issueDate: Date
  dueDate: Date | null
  notes: string
}

export async function createInvoice(f: InvoiceInput, b: Branding, by: string): Promise<{ id: string; number: string }> {
  const t = computeTotals(f.lines, f.discount, f.taxRate)
  if (!f.clientId) throw new Error('Select a client.')
  if (t.lines.length === 0) throw new Error('Add at least one line item.')
  const ref = doc(invoicesCol())
  const token = newToken()
  const currency = b.currency || 'PKR'
  const number = await runTransaction(db, async (tx) => {
    const cRef = doc(db, 'counters', 'invoices')
    const c = await tx.get(cRef)
    const next = Math.max(1, n(c.data()?.next, 1))
    const num = formatNumber(b.invoicePrefix || 'INV-', next)
    tx.set(cRef, { next: next + 1 }, { merge: true })
    const issueDate = Timestamp.fromDate(f.issueDate)
    const dueDate = f.dueDate ? Timestamp.fromDate(f.dueDate) : null
    tx.set(ref, {
      number: num, clientId: f.clientId, clientName: f.clientName, licenseId: f.licenseId, planType: f.planType, issueDate, dueDate, currency,
      ...t, paid: 0, balance: t.total, status: 'unpaid', verifyToken: token, notes: f.notes,
      createdAt: serverTimestamp(), createdBy: by, updatedAt: serverTimestamp(), cancelledAt: null, cancelReason: '', lastPaymentAt: null
    })
    tx.set(publicInvoiceRef(token), publicCopy({ number: num, clientName: f.clientName, issueDate, dueDate, currency, total: t.total, paid: 0, lines: t.lines }, b))
    txAudit(tx, 'Invoice created', by, num, `${num} for ${f.clientName}: ${currency} ${t.total}`, f.licenseId, { invoiceId: ref.id, total: t.total })
    return num
  })
  // Best effort and not awaited: the invoice is saved; the UI opens it at once.
  void syncLicensePayment(f.licenseId, 'unpaid')
  return { id: ref.id, number }
}

export async function updateInvoice(inv: Invoice, f: InvoiceInput, b: Branding, by: string): Promise<void> {
  const t = computeTotals(f.lines, f.discount, f.taxRate)
  if (t.lines.length === 0) throw new Error('Add at least one line item.')
  await runTransaction(db, async (tx) => {
    const cur = invoiceFromSnap(await tx.get(invoiceRef(inv.id)))
    if (cur.status === 'cancelled') throw new Error('Cancelled invoices cannot be edited.')
    if (cur.paid > 0) throw new Error('Only unpaid invoices can be edited.')
    const r = rebalance(t.total, cur.paid)
    const issueDate = Timestamp.fromDate(f.issueDate)
    const dueDate = f.dueDate ? Timestamp.fromDate(f.dueDate) : null
    tx.update(invoiceRef(inv.id), {
      clientId: f.clientId, clientName: f.clientName, licenseId: f.licenseId, planType: f.planType, issueDate, dueDate,
      ...t, ...r, notes: f.notes, updatedAt: serverTimestamp()
    })
    tx.set(publicInvoiceRef(cur.verifyToken), publicCopy({ number: cur.number, clientName: f.clientName, issueDate, dueDate, currency: cur.currency, total: t.total, paid: r.paid, lines: t.lines }, b))
    txAudit(tx, 'Invoice edited', by, cur.number, `${cur.number}: total ${cur.total} -> ${t.total}`, f.licenseId, { invoiceId: inv.id })
  })
}

export async function cancelInvoice(inv: Invoice, reason: string, b: Branding, by: string): Promise<void> {
  if (!reason.trim()) throw new Error('Enter a reason.')
  await runTransaction(db, async (tx) => {
    const cur = invoiceFromSnap(await tx.get(invoiceRef(inv.id)))
    if (cur.status === 'cancelled') throw new Error('Invoice is already cancelled.')
    tx.update(invoiceRef(inv.id), { status: 'cancelled', cancelledAt: serverTimestamp(), cancelReason: reason.trim(), updatedAt: serverTimestamp() })
    tx.set(publicInvoiceRef(cur.verifyToken), publicCopy(cur, b, true))
    txAudit(tx, 'Invoice cancelled', by, cur.number, `${cur.number}: ${reason.trim()}`, cur.licenseId, { invoiceId: inv.id })
  })
  invalidate('payments')
}

/** Deletable: cancelled, or no money recorded (every payment voided). Mirrors firestore.rules. */
export function canDeleteInvoice(inv: Pick<Invoice, 'status' | 'paid'>): boolean {
  return inv.status === 'cancelled' || inv.paid <= 0
}

/**
 * Permanently deletes an invoice that is cancelled or has no (non-void) payment: its payments, its public
 * verification copy and the invoice itself go in ONE batch with a 'financial' activity entry (the rules only allow
 * deleting payments together with their invoice).
 */
export async function deleteInvoice(inv: Invoice, by: string): Promise<void> {
  if (!canDeleteInvoice(inv)) throw new Error('Only cancelled invoices or invoices without payments can be deleted. Cancel it first.')
  const pays = await getDocs(paymentsCol(inv.id))
  if (pays.size > 400) throw new Error('This invoice has too many payment records to delete at once.')
  const b = writeBatch(db)
  pays.docs.forEach((p) => b.delete(p.ref))
  if (inv.verifyToken) b.delete(publicInvoiceRef(inv.verifyToken))
  b.delete(invoiceRef(inv.id))
  writeActivity(b, {
    action: 'Invoice deleted', category: 'financial', target: inv.number, targetType: 'invoice', licenseId: inv.licenseId || null,
    details: `${inv.number} for ${inv.clientName} (${inv.status}, ${inv.currency} ${inv.total}) deleted with ${pays.size} payment record(s) by ${by}`,
    meta: { invoiceId: inv.id, total: inv.total, paid: inv.paid, payments: pays.size }
  })
  await b.commit()
  invalidate('payments')
}

export interface PaymentInput { amount: number; method: string; reference: string; date: Date }

export async function recordPayment(inv: Invoice, p: PaymentInput, b: Branding, by: string): Promise<{ receiptNo: string; paymentId: string }> {
  const pRef = doc(paymentsCol(inv.id))
  const res = await runTransaction(db, async (tx) => {
    const cur = invoiceFromSnap(await tx.get(invoiceRef(inv.id)))
    const cRef = doc(db, 'counters', 'receipts')
    const c = await tx.get(cRef)
    if (cur.status === 'cancelled') throw new Error('Invoice is cancelled.')
    const r = applyPayment(cur.total, cur.paid, p.amount)
    const next = Math.max(1, n(c.data()?.next, 1))
    const receiptNo = formatNumber(b.receiptPrefix || 'RCP-', next)
    tx.set(cRef, { next: next + 1 }, { merge: true })
    tx.set(pRef, { amount: round2(p.amount), method: p.method, reference: p.reference, date: Timestamp.fromDate(p.date), receiptNo, createdAt: serverTimestamp(), createdBy: by })
    tx.update(invoiceRef(inv.id), { paid: r.paid, balance: r.balance, status: r.status, updatedAt: serverTimestamp(), lastPaymentAt: serverTimestamp() })
    tx.update(publicInvoiceRef(cur.verifyToken), { paymentStatus: r.status, updatedAt: serverTimestamp() })
    txAudit(tx, 'Payment recorded', by, cur.number, `${receiptNo}: ${cur.currency} ${round2(p.amount)} (${p.method}) on ${cur.number}`, cur.licenseId, { invoiceId: inv.id, paymentId: pRef.id, amount: round2(p.amount) })
    return { receiptNo, status: r.status, licenseId: cur.licenseId }
  })
  invalidate('payments')
  void syncLicensePayment(res.licenseId, res.status)
  return { receiptNo: res.receiptNo, paymentId: pRef.id }
}

export async function voidInvoicePayment(inv: Invoice, pay: InvoicePayment, reason: string, by: string): Promise<void> {
  if (!reason.trim()) throw new Error('Enter a reason.')
  const res = await runTransaction(db, async (tx) => {
    const cur = invoiceFromSnap(await tx.get(invoiceRef(inv.id)))
    const pRef = doc(paymentsCol(inv.id), pay.id)
    const ps = paymentFromSnap(await tx.get(pRef))
    if (ps.cancelled) throw new Error('Payment is already void.')
    if (cur.status === 'cancelled') throw new Error('Invoice is cancelled.')
    const r = voidPayment(cur.total, cur.paid, ps.amount)
    tx.update(pRef, { cancelled: true, cancelledAt: serverTimestamp(), cancelledBy: by, cancelReason: reason.trim() })
    tx.update(invoiceRef(inv.id), { paid: r.paid, balance: r.balance, status: r.status, updatedAt: serverTimestamp() })
    tx.update(publicInvoiceRef(cur.verifyToken), { paymentStatus: r.status, updatedAt: serverTimestamp() })
    txAudit(tx, 'Payment voided', by, cur.number, `${ps.receiptNo} (${cur.currency} ${ps.amount}) on ${cur.number}: ${reason.trim()}`, cur.licenseId, { invoiceId: inv.id, paymentId: pay.id })
    return { status: r.status, licenseId: cur.licenseId }
  })
  invalidate('payments')
  void syncLicensePayment(res.licenseId, res.status)
}

/** Best effort: licenses.update needs licenses.manage — silently skipped when the admin lacks it. */
async function syncLicensePayment(licenseId: string, status: 'paid' | 'partial' | 'unpaid'): Promise<void> {
  if (!licenseId) return
  try {
    await updateDoc(licenseRef(licenseId), { paymentStatus: status, updatedAt: serverTimestamp() })
  } catch {
    /* no licenses.manage permission */
  }
}

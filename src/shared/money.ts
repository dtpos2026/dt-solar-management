/** Monetary helpers. All amounts are rounded to 2 decimals, quantities to 3. */
export const EPS = 0.005

export function round2(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round((n + Number.EPSILON) * 100) / 100
}

export function round3(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round((n + Number.EPSILON) * 1000) / 1000
}

/** Cost per unit keeps 4 decimals so that qty * cost stays accurate. */
export function round4(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.round((n + Number.EPSILON) * 10000) / 10000
}

export function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined || v === '') return fallback
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : fallback
}

export function sum(values: number[]): number {
  return round2(values.reduce((a, b) => a + b, 0))
}

export function formatMoney(n: number, symbol = 'Rs.', decimals = 0): string {
  const v = round2(n || 0)
  const neg = v < 0
  const s = Math.abs(v).toLocaleString('en-PK', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: Math.max(decimals, 2)
  })
  return `${neg ? '-' : ''}${symbol ? symbol + ' ' : ''}${s}`
}

export function formatQty(n: number): string {
  const v = round3(n || 0)
  return v.toLocaleString('en-PK', { maximumFractionDigits: 3 })
}

/** Convert a number to words (South-Asian numbering: lakh, crore) for invoices. */
export function amountInWords(amount: number, currencyWord = 'Rupees', style: 'south_asia' | 'international' = 'south_asia'): string {
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
    'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen']
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety']
  const two = (n: number): string => (n < 20 ? ones[n] : tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : ''))
  const three = (n: number): string => {
    const h = Math.floor(n / 100)
    const r = n % 100
    return [h ? ones[h] + ' Hundred' : '', r ? two(r) : ''].filter(Boolean).join(' ')
  }
  const v = round2(Math.abs(amount))
  let whole = Math.floor(v)
  const paisa = Math.round((v - whole) * 100)
  if (whole === 0 && paisa === 0) return `Zero ${currencyWord} Only`
  const parts: string[] = []
  if (style === 'international') {
    const billion = Math.floor(whole / 1000000000)
    whole %= 1000000000
    const million = Math.floor(whole / 1000000)
    whole %= 1000000
    const thou = Math.floor(whole / 1000)
    whole %= 1000
    if (billion) parts.push(three(billion) + ' Billion')
    if (million) parts.push(three(million) + ' Million')
    if (thou) parts.push(three(thou) + ' Thousand')
    if (whole) parts.push(three(whole))
    let w = parts.join(' ')
    if (w) w += ' ' + currencyWord
    if (paisa) w += (w ? ' and ' : '') + two(paisa) + ' Paisa'
    return w + ' Only'
  }
  const crore = Math.floor(whole / 10000000)
  whole %= 10000000
  const lakh = Math.floor(whole / 100000)
  whole %= 100000
  const thousand = Math.floor(whole / 1000)
  whole %= 1000
  if (crore) parts.push((crore > 99 ? three(crore) : two(crore)) + ' Crore')
  if (lakh) parts.push(two(lakh) + ' Lakh')
  if (thousand) parts.push(two(thousand) + ' Thousand')
  if (whole) parts.push(three(whole))
  let words = parts.join(' ')
  if (words) words += ' ' + currencyWord
  if (paisa) words += (words ? ' and ' : '') + two(paisa) + ' Paisa'
  return words + ' Only'
}

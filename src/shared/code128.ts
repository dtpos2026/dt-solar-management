/**
 * Code 128 barcodes (what shop scanners read), made from the product code or barcode text. Code Set B covers the printable ASCII
 * characters; an even run of only digits is packed in Code Set C (half the width). Pure functions, so they are easy to test.
 */
const PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213', '221312', '231212', '112232', '122132', '122231', '113222',
  '123122', '123221', '223211', '221132', '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211', '212123', '212321',
  '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313', '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121',
  '313121', '211331', '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111', '314111', '221411', '431111', '111224',
  '111422', '121124', '121421', '141122', '141221', '112214', '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141', '214121', '412121', '111143', '111341', '131141', '114113',
  '114311', '411113', '411311', '113141', '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
]
const START_B = 104
const START_C = 105
const STOP = 106

/** The symbol values of a text, start and checksum included (stop not included). */
export function code128Values(text: string): number[] {
  if (!text) throw new Error('Nothing to encode.')
  for (const ch of text) if (ch.charCodeAt(0) < 32 || ch.charCodeAt(0) > 126) throw new Error(`The character "${ch}" cannot be put in a Code 128 barcode.`)
  const values: number[] = []
  if (/^\d+$/.test(text) && text.length >= 4 && text.length % 2 === 0) {
    values.push(START_C)
    for (let i = 0; i < text.length; i += 2) values.push(Number(text.slice(i, i + 2)))
  } else {
    values.push(START_B)
    for (const ch of text) values.push(ch.charCodeAt(0) - 32)
  }
  let sum = values[0]
  for (let i = 1; i < values.length; i++) sum += values[i] * i
  values.push(sum % 103)
  return values
}

/** Alternating bar and space widths in modules, starting with a bar (quiet zones not included). */
export function code128Modules(text: string): number[] {
  return [...code128Values(text), STOP].flatMap((v) => PATTERNS[v].split('').map(Number))
}

/** An SVG of the barcode: black bars on white, with a 10 module quiet zone on each side. */
export function code128Svg(text: string, opts: { height?: number; module?: number } = {}): string {
  const mod = opts.module ?? 1.6
  const height = opts.height ?? 40
  const widths = code128Modules(text)
  const quiet = 10 * mod
  let x = quiet
  let bars = ''
  widths.forEach((w, i) => {
    if (i % 2 === 0) bars += `<rect x="${Math.round(x * 100) / 100}" y="0" width="${Math.round(w * mod * 100) / 100}" height="${height}"/>`
    x += w * mod
  })
  const total = Math.round((x + quiet) * 100) / 100
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${height}" width="${total}" height="${height}" preserveAspectRatio="none" fill="#000">${bars}</svg>`
}

export const PATTERN_COUNT = PATTERNS.length
export const patternOf = (value: number): string => PATTERNS[value]

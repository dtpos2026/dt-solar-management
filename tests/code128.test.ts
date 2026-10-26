/** Code 128 encoder, checked against bit patterns made by the JsBarcode library for the same texts. */
import { describe, expect, it } from 'vitest'
import { PATTERN_COUNT, code128Modules, code128Svg, code128Values, patternOf } from '../src/shared/code128'

const bits = (text: string): string =>
  code128Modules(text)
    .map((w, i) => (i % 2 === 0 ? '1' : '0').repeat(w))
    .join('')

describe('Code 128', () => {
  it('has the 107 symbol patterns: 11 modules each (13 for the stop), alternating bar and space, all different', () => {
    expect(PATTERN_COUNT).toBe(107)
    const seen = new Set<string>()
    for (let v = 0; v < 106; v++) {
      const p = patternOf(v)
      expect(p).toHaveLength(6)
      expect(p.split('').reduce((a, c) => a + Number(c), 0)).toBe(11)
      expect(seen.has(p)).toBe(false)
      seen.add(p)
    }
    expect(patternOf(106)).toBe('2331112')
  })

  it('makes the same bars as JsBarcode (Code Set B for text, Code Set C for even runs of digits)', () => {
    const expected: Record<string, string> = {
      P00000012: '11010010000111011101101001110110010011101100100111011001001110110010011101100100111011001001110011011001110010111011000101100011101011',
      'Hello 123': '11010010000110001010001011001000011001010000110010100001000111101011011001100100111001101100111001011001011100111101000101100011101011',
      'LED-12W': '1101001000010001101110100011010001011000100010011011100100111001101100111001011101000110101000110001100011101011',
      'Breaker 32A': '110100100001000101100010010011110101100100001001011000011000010010101100100001001001111011011001100110010111001100111001010100011000100101100001100011101011',
      'a~Z ': '1101001000010010110000100010111101110110001011011001100100111011001100011101011',
      '8901111000012x': '110100100001110100110011100101100100111011001001110011010011100110100111001101001110011010011101100100111011001001110110010011101100100111001101100111001011110010010111101010001100011101011',
      '00000012': '1101001110011011001100110110011001101100110010110011100110001011101100011101011',
      '123456': '11010011100101100111001000101100011100010110100011011101100011101011'
    }
    for (const [text, bar] of Object.entries(expected)) expect(bits(text), text).toBe(bar)
  })

  it('has the right start, checksum and a stop', () => {
    expect(code128Values('P00000012')).toHaveLength(1 + 9 + 1)
    expect(code128Values('P00000012')[0]).toBe(104)
    expect(code128Values('123456')[0]).toBe(105)
    expect(code128Values('123456')).toEqual([105, 12, 34, 56, (105 + 12 * 1 + 34 * 2 + 56 * 3) % 103])
    expect(bits('A').endsWith('1100011101011')).toBe(true)
  })

  it('refuses text it cannot encode and makes an SVG', () => {
    expect(() => code128Values('')).toThrow(/Nothing to encode/)
    expect(() => code128Values('café')).toThrow(/cannot be put/)
    const svg = code128Svg('P00000012', { height: 30 })
    expect(svg.startsWith('<svg')).toBe(true)
    expect((svg.match(/<rect/g) ?? []).length).toBeGreaterThan(20)
  })
})

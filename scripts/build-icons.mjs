/**
 * Renders resources/brand/app-icon.svg to PNG sizes and builds a Windows .ico.
 * Requires Playwright (Chromium). Usage: node scripts/build-icons.mjs [path-to-playwright]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { createRequire } from 'module'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const pwPath = process.argv[2] || 'playwright'
const { chromium } = require(pwPath)

const svg = readFileSync(join(root, 'resources/brand/app-icon.svg'), 'utf8')
const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256, 512]
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {})
const page = await browser.newPage()
const pngs = {}
for (const s of sizes) {
  await page.setViewportSize({ width: s, height: s })
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('width="512" height="512"', `width="${s}" height="${s}"`)}</body></html>`)
  pngs[s] = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: s, height: s } })
}
await browser.close()

mkdirSync(join(root, 'build'), { recursive: true })
writeFileSync(join(root, 'resources/icon.png'), pngs[512])
writeFileSync(join(root, 'build/icon.png'), pngs[512])
writeFileSync(join(root, 'src/renderer/src/assets/app-icon.png'), pngs[256])

// ICO with embedded PNGs (Vista+ format)
const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
const header = Buffer.alloc(6)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(icoSizes.length, 4)
const entries = []
const datas = []
let offset = 6 + 16 * icoSizes.length
for (const s of icoSizes) {
  const data = pngs[s]
  const e = Buffer.alloc(16)
  e.writeUInt8(s >= 256 ? 0 : s, 0)
  e.writeUInt8(s >= 256 ? 0 : s, 1)
  e.writeUInt8(0, 2)
  e.writeUInt8(0, 3)
  e.writeUInt16LE(1, 4)
  e.writeUInt16LE(32, 6)
  e.writeUInt32LE(data.length, 8)
  e.writeUInt32LE(offset, 12)
  offset += data.length
  entries.push(e)
  datas.push(data)
}
writeFileSync(join(root, 'build/icon.ico'), Buffer.concat([header, ...entries, ...datas]))
console.log('Icons written: resources/icon.png, build/icon.png, build/icon.ico')

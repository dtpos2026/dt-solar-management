/**
 * Minimal, dependency-free ZIP reader (central directory + stored/deflate entries). Used to open legacy backups such
 * as Vyapar .vyb files, which are ordinary ZIP archives containing a SQLite database (.vyp).
 */
import { readFileSync } from 'fs'
import { inflateRawSync } from 'zlib'

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  offset: number
  crc32: number
}

export function listZip(buf: Buffer): ZipEntry[] {
  // End of central directory record: signature 0x06054b50, searched from the end (comment up to 64 KB).
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP archive (end of central directory not found).')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: ZipEntry[] = []
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('Corrupt ZIP central directory.')
    const method = buf.readUInt16LE(p + 10)
    const crc32 = buf.readUInt32LE(p + 16)
    const compressedSize = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const offset = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    out.push({ name, method, compressedSize, size, offset, crc32 })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

export function crc32(data: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function readZipEntry(buf: Buffer, e: ZipEntry): Buffer {
  const p = e.offset
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new Error(`Corrupt ZIP entry header for ${e.name}.`)
  const nameLen = buf.readUInt16LE(p + 26)
  const extraLen = buf.readUInt16LE(p + 28)
  const start = p + 30 + nameLen + extraLen
  const raw = buf.subarray(start, start + e.compressedSize)
  let data: Buffer
  if (e.method === 0) data = Buffer.from(raw)
  else if (e.method === 8) data = inflateRawSync(raw)
  else throw new Error(`Unsupported ZIP compression method ${e.method} for ${e.name}.`)
  if (data.length !== e.size) throw new Error(`ZIP entry ${e.name} has the wrong size after extraction.`)
  if (crc32(data) !== e.crc32) throw new Error(`ZIP entry ${e.name} failed its CRC check — the backup file is damaged.`)
  return data
}

export function readZipFile(file: string): { buf: Buffer; entries: ZipEntry[] } {
  const buf = readFileSync(file)
  return { buf, entries: listZip(buf) }
}

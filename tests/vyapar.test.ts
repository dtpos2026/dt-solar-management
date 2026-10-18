import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { convertVyapar, createTargetDb } from '../src/main/legacy/vyapar'
import { validateConversion } from '../src/main/legacy/vyaparValidate'
import { buildDatabaseFromJs1, exportJs1, readJs1, writeJs1 } from '../src/main/backup-json'
import { docDue } from '../src/main/services/payments'
import { totalQty } from '../src/main/services/inventory'
import { setupCtx } from './helpers'
import { fakeVyapar } from './fakeVyapar'

const dir = mkdtempSync(join(tmpdir(), 'dtsp-vyapar-test-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe('Vyapar conversion', () => {
  const src = fakeVyapar()
  const out = createTargetDb(join(dir, 'converted.db'))
  const result = out.transaction(() => convertVyapar(src, out, { sourceFile: 'test.vyb', sourceSha256: 'x', vypName: 'test.vyp' }, { ownerPassword: 'Temp-pass-1' }))()

  it('passes every reconciliation check against the source', () => {
    const v = validateConversion(src, out, result)
    expect(v.checks.filter((c) => !c.pass).map((c) => `${c.name}: ${c.expected} vs ${c.actual}`)).toEqual([])
  })

  it('keeps ids, numbers, text and money exactly', () => {
    const sale = out.prepare('SELECT * FROM documents WHERE id = 13').get() as Record<string, unknown>
    expect(sale.number).toBe('WSS1')
    expect(sale.ref_doc_id).toBe(12)
    expect((out.prepare('SELECT status FROM documents WHERE id = 12').get() as { status: string }).status).toBe('converted')
    expect((out.prepare('SELECT details FROM document_lines WHERE id = 102').get() as { details: string }).details).toBe('585W "N-type", bifacial')
    expect((out.prepare('SELECT name FROM parties WHERE id = 1').get() as { name: string }).name).toBe('Customer "Ali", Multan — علی')
    expect((out.prepare('SELECT party_ref FROM documents WHERE id = 11').get() as { party_ref: string }).party_ref).toBe('BILL-7')
    expect(docDue(out, 13)).toBe(150) // 600 - 100 at billing - 300 receipt - 50 discount
    expect(docDue(out, 11)).toBe(600)
    expect(totalQty(out, 1)).toBe(6)
    const disc = out.prepare('SELECT * FROM party_adjustments').all() as Array<Record<string, unknown>>
    expect(disc).toHaveLength(1)
    expect(disc[0]).toMatchObject({ direction: 'credit', amount: 50, document_id: 13 })
    // every source row archived verbatim
    expect((out.prepare("SELECT COUNT(*) AS c FROM legacy_records WHERE table_name = 'kb_transactions'").get() as { c: number }).c).toBe(6)
    // owner must change the temporary password
    expect((out.prepare('SELECT must_change_password FROM users').get() as { must_change_password: number }).must_change_password).toBe(1)
  })
})

describe('JSON backup (.js1)', () => {
  it('round-trips a database exactly and detects tampering', () => {
    const ctx = setupCtx({ demo: true })
    const a = exportJs1(ctx.db, { appVersion: 'test' })
    const f = join(dir, 'a.js1')
    writeJs1(f, a)
    const restored = join(dir, 'restored.db')
    buildDatabaseFromJs1(readJs1(f), restored)
    const r = new Database(restored, { readonly: true })
    const b = exportJs1(r, { appVersion: 'test' })
    r.close()
    expect(b.sha256).toBe(a.sha256)
    expect(b.counts).toEqual(a.counts)

    const tampered = { ...a, tables: { ...a.tables, parties: { ...a.tables.parties, rows: a.tables.parties.rows.slice(1) } } }
    const t = join(dir, 't.js1')
    writeJs1(t, tampered)
    expect(() => readJs1(t)).toThrow()
  })
})

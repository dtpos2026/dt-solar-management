# DT Solar Pro — release hardening handover report

Branch `claude/kind-rubin-pbd9yz`. All results below were produced by commands actually executed in the build container
(Linux, Electron 44 under Xvfb, Firebase emulators with Java). Windows-only items are listed as not tested.

## Verdict: **PASS WITH LIMITATIONS**

No known open critical defect in licensing, data integrity, authorization or printing. The limitations are items that
cannot be verified without real Windows hardware or the live Firebase project (section 5), plus the documented by-design
limit that a fully disconnected computer cannot be revoked instantly.

## 1. Confirmed defects — root cause and fix

| Defect | Root cause | Fix |
|---|---|---|
| Suspended / revoked license kept working until a later check | License status was checked online only at start-up / periodically; writes used the cached status; a failed check could leave the old state | Before every protected write the app re-verifies when the last check is older than 5 min (≤ 4 s wait, coalesced, 60 s back-off when offline); revoked / suspended / device-released blocks immediately with a specific message; the remote decision is stored in the license folder **and** the database (deleting one file does not restore access); certificates are never installed from a suspended / revoked status. Offline: signed check-in deadline + grace period (set per license). `docs/LICENSING.md` |
| Fresh install started a 15-day trial | Local trial in the license service and wizard | Removed. Nothing can be recorded until a certificate is installed (online approval or offline code). A trial is a 15-day license issued by the Super Admin (**Issue trial**) and still needs device approval. Old local-trial installs open read-only with their data intact |
| Valid key alone activated a computer | Portal "Auto-approve" toggle; requests rejected on any error | Auto-approve removed; explicit approval per computer; same computer = re-issue (no new slot); full limit → "needs reassignment" → **Replace computer X** (release + approve in one transaction); race test: two approvals for the last slot → exactly one wins |
| Wrong location (Lahore for Burewala) | Location came from the internet IP, which resolves to the ISP's gateway city, and was not labelled as approximate | New source "Windows location service" (consent, accuracy in metres, cached 6 h); IP mode labelled "Approximate (internet IP — usually the ISP's city)"; manual; unavailable is reported, never faked. Portal shows source, accuracy and last update |
| PDF "one long page" | The preview window drew one continuous sheet with no page boundaries (the PDFs themselves were already A4-paginated — measured) | Page rules per print (A4 portrait / landscape, margins, "Page x of y"); preview shows the real PDF page count and a page view; landscape for wide reports; thermal 80 mm unaffected |
| Activity log clearing unreliable, 90-day limit | Firestore rule allowed deletes only > 90 days and not license / financial categories; UI did not re-page after deleting | Rules: `audit.manage` may delete any non-security entry of any age; **security** entries are a protected trail. UI: scope (category / date range), exact count before confirming, batched delete, cache reset, a security entry records each clearing. License history and released device records can be cleared too |
| Portal slow | N+1 reads (every license's devices), unbounded listeners per page, no shared cache | Device summary on the license, shared live store with invalidation, bounded queries. Measured below |
| Horizontal scroll / clipped actions at 1280×720 and 125–150 % scaling | `1fr` grid tracks and un-wrapped tables | `minmax(0,1fr)` tracks, scroll containers, responsive sidebar; audit of 23 screens × 5 configurations: no overflow |
| CSV only for 3 entities, options ignored | Routes dropped options; no export | CSV export + import for products, categories, customers, suppliers, invoices (+lines), payments, expenses, stock levels; preview, mapping, dry run, duplicate policy, counts |

## 2. Main changes
- Desktop licensing: `src/main/license/*`, `src/main/cloud/*`, `src/main/ipc/router.ts` (write gating), `pages/auth/Setup.tsx`, `pages/license/*`, `pages/settings/CloudSection.tsx`
- Printing: `src/renderer/src/print/*` (incl. `pageRules.ts`), `src/main/printing.ts`, `routes/access.ts`, `scripts/pdf-check.mjs`
- Portal: `admin-panel/src/**` (redesign, `lib/liveData.ts`, `lib/queryCache.ts`, licensing pages, clearing), `admin-panel/firestore.rules`, `admin-panel/DATA_MODEL.md`
- Backups: `src/main/backup-json.ts` (.js1), `src/main/services/importer.ts`, `csvExport.ts`, `pages/backup/*`
- Vyapar import: `src/main/legacy/*`, `routes/legacy.ts`, `scripts/convert-vyapar.ts`, `docs/VYAPAR_IMPORT.md`
- UI polish: `components/ui.tsx`, `DataTable.tsx`, `styles.css`, `Shell.tsx`, page layouts

## 3. Database migrations and deployment
- Migration **v9** (additive only): `legacy_sources`, `legacy_records`, `legacy_id_map`, `party_adjustments.document_id`. Runs automatically with a pre-migration backup. No destructive change.
- Desktop: `npm install` → `npm run build` → `npm run dist` (installer in `release\1.0.0\`). Keep the existing `keys\license-private.pem` (copy the `keys` folder into the new source folder) so existing licenses stay valid.
- Portal: in `admin-panel`: `npm install` → `npm run build` → **`firebase deploy --only firestore:rules`** (required: new rules) → `firebase deploy --only hosting`.
- Rollback: desktop — reinstall the previous installer and restore the automatic pre-migration backup (`Documents\DT Solar Pro Backups`); portal — `firebase hosting:rollback` and redeploy the previous `firestore.rules` from git.

## 4. Tests executed (actual results)
| Test | Result |
|---|---|
| `npm run typecheck` (desktop + shared) | 0 errors |
| `npx vitest run` | 16 files, **277 passed** |
| Portal `tsc --noEmit` + `vite build` | pass |
| `npx electron-vite build` | pass |
| `scripts/e2e-smoke.mjs` (wizard: no trial offered, Continue disabled until activation, offline activation, every screen, print previews + PDFs, CSV dry run) | **0 errors** |
| `scripts/pdf-check.mjs` | **18/18 ok** — invoice 120 lines = 11 A4 pages, quotation 60 = 6, statement 200 rows = 7, landscape stock report 842×595, thermal 227×437, WhatsApp PDFs paginated, preview page count = PDF page count |
| Firestore rules + licensing on emulator (`admin-panel/tests`) | **34/34** (incl. approval race, re-issue, reassignment race, trial issuance) |
| `scripts/cloud-emulator-check.mjs` (desktop REST vs real rules) | **44 passed, 0 failed** — suspend blocks next write, cert not installed while suspended, device deactivation blocks with device message, deleting state.json still blocked, device-location heartbeat accepted |
| Portal browser smoke on emulators (all 11 pages + requests, offline, key, public verify) | 0 page errors (only map-tile network errors — no internet in the build container) |
| Vyapar conversion of the customer backup | **45/45 checks** (counts, totals, every bill's outstanding, every party balance, cash/bank, stock, verbatim archive, integrity); .js1 restore → re-export → restore: identical SHA-256; restored in the real app, admin login + forced password change, data visible |

## 5. Not tested / outstanding
- Real Windows: installer build (`npm run dist`), physical printers, Windows location service via PowerShell (parser, timeouts and caching are unit-tested), display-scaling on real monitors.
- Live Firebase project (all portal and REST tests ran on the emulator with the same rules); real web.whatsapp.com QR (container has no internet).
- By design: a computer that never connects can only be blocked when its signed check-in deadline + grace period expires.
- Minor: Client detail still reads one client's devices per license (small); license list cache can show another admin's change up to 15 s late (own changes are immediate); CSV cannot carry nested history (full JSON backup does).
- Multi-factor sign-in for admins needs Firebase Identity Platform (paid).

## 6. Performance (emulator, seeded data)
| Workflow | Before | After |
|---|---|---|
| Devices page (300 licenses / 600 devices / 600 heartbeats) | 302 queries, 1500 reads, 2152 ms | 2 queries, 900 reads, 244 ms (cached reload: 0 reads) |
| Dashboard | 950 queries, 3789 reads, settled 7214 ms | 1096 reads, first data 394 ms, settled 2177 ms |
| 5 in-app navigations | 5974 extra reads | 0 extra reads |
| Client detail / Activity log / Billing | 316 / 402 / 804 reads | 18 / 202 / 653 reads |

## 7. Security
- No private key, password or secret is committed (`git grep` for private-key headers: only code that parses user-supplied keys; `resources/license-public.pem` is a placeholder until the build creates it). The signing key stays on the owner's PC; the app ships only the public key; a test key is honoured only by unpackaged builds.
- License keys are masked in portal lists and never written to logs; device ids are shortened in logs.
- Destructive portal actions are confirmed and permission-checked by Firestore rules (tested per role).

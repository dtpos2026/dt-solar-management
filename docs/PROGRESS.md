# DT Solar Pro v1.1 — implementation checklist

Status keys: [x] done & tested · [~] partial · [ ] not started · [!] blocked (needs credentials / input)

## Foundation (shared)
- [x] Desktop schema v2 migration (item details, PIN, archive flags, day/month closing, templates, support queue, WhatsApp log, import runs)
- [x] New desktop permissions + automatic upgrade of built-in roles (`PERMISSION_UPGRADES`)
- [x] IPC route areas (`src/main/ipc/routes/*.ts`), Settings sections registry (`pages/settings/sections.tsx`)
- [x] License payload v1.1 fields (planType, clientId, maxDevices, poweredBy, detached) + detached evaluation
- [x] Cloud data model (`admin-panel/DATA_MODEL.md`) and Firestore rules with role-based admin permissions
- [x] Super Admin shell: 11-item sidebar, RBAC hooks (`useCan`), activity logger, public `/v/<token>` entry

## Desktop areas
- [ ] documents — item name + description in editor/preview/print/PDF, invoice delete rules, template designer, thermal layout, Powered-by toggle
- [ ] catalog — product delete/archive + category change, project delete/archive, firm activate/deactivate, firm isolation + limit tests
- [ ] data — day/month closing + closing backup, backup history/export/import/validation, CSV import + reconciliation
- [ ] access — user selection + PIN login, PIN lock screen, forced password change, printers page + per-document printer, test print
- [ ] cloud — registration in setup wizard, heartbeat + consented location, support messages with offline queue, certificate refresh, License & About in Settings
- [ ] assist — offline Urdu/English help assistant, WhatsApp (chat link + optional Cloud API) with send log

## Super Admin portal areas
- [ ] portal-admin — Admins (RBAC users), Settings (branding/invoice/bank/QR/signing key), Activity Log (filters/export/archive/retention), Verify Key, rules tests
- [ ] portal-licensing — Dashboard metrics/charts, Clients, Licenses lifecycle (renew/plan/limits/detach/history), Devices (+requests), Device Map
- [ ] portal-billing — Billing invoices/payments/receipts/reports/PDF, public QR verification page, Support conversations

## Blocked / needs input
- [!] External backup conversion: no sample backup was supplied — generic CSV import pipeline provided instead
- [!] WhatsApp Cloud API: needs Meta Business phone-number id + access token (chat-link mode works without)
- [!] Multi-factor auth for admins: needs Firebase Identity Platform (paid upgrade)

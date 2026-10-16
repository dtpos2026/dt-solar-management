# DT Solar Pro — cloud data model (Firebase Spark plan)

Only **Firestore + Email/Password Auth** are used. There are no Cloud Functions, so every rule that must be
enforced "server side" lives in `firestore.rules`. The desktop app talks to Firestore through the REST API
without signing in (API key only); everything it may touch is either readable by an unguessable id or limited
to a strict shape by the rules.

Secrets used as document ids (never listed, only fetched by id):

| Secret | Who knows it | Used for |
| --- | --- | --- |
| `licenseId` (Firestore auto id, 20 chars) | the licensed installation (inside its certificate) | `licenseStatus/{licenseId}` |
| `installToken` (40 random chars `[A-Za-z0-9]`, generated once per installation, stored in the license folder) | that installation only | `heartbeats/{installToken}`, `supportThreads/{installToken}` |
| `verifyToken` (32 random chars) | anyone holding the printed invoice | `publicInvoices/{verifyToken}` |
| activation request id (28 random chars) | the requesting installation | `activationRequests/{id}` |

Timestamps written by the desktop use the REST `documents:commit` endpoint with
`updateTransforms: [{ fieldPath, setToServerValue: 'REQUEST_TIME' }]`, so rules can require `== request.time`.

## Admin side

### `admins/{uid}`
`email, name, role, permissions: string[], active: bool, createdAt, createdBy, updatedAt`

* `role`: `owner` | `manager` | `sales` | `billing` | `support` | `technical` | `custom` (legacy `superadmin` = owner).
* Owners have every permission. Others have exactly `permissions` (see `src/lib/perm.ts`).
* Only an owner may create/modify owners or grant `admins.manage`. Nobody edits their own role/permissions.
* `active: false` blocks the account in the rules immediately (Firebase Auth accounts cannot be disabled from the
  browser on the Spark plan; the owner can also delete the user in Firebase Console).
* Bootstrap: `digitaltarget.digital@gmail.com` may create its own owner document once.

Admin permission keys: `clients.view clients.manage licenses.view licenses.generate licenses.manage devices.view
devices.manage billing.view billing.create billing.payments support.manage audit.view audit.manage branding.manage
admins.manage verify.use`.

### `clients/{clientId}`
`code, company, ownerName, phone, email, address, city, logo (data URL ≤ 200 KB), status ('active'|'suspended'|'archived'),
plan, planType ('monthly'|'yearly'|'lifetime'), allowedFirms, allowedDevices, notes, registeredAt, createdAt, createdBy, updatedAt`

* Delete (`clients.manage`): refused while an active (status active, not expired) license is linked — the dialog offers
  to unlink those; suspended / revoked / expired licenses are unlinked (`clientId: ''` + history) in the same
  transaction as the delete and its `client_deleted` audit entry. Invoices are never deleted (they keep `clientName`).
* License form "save as client": the company / owner / phone typed on a license create or update the client in the
  license transaction — the picked client, else an existing non-archived client with the same phone (digits only,
  last 10) or the same company + owner name (case-insensitive), else a new client (`counters/clients`). An existing
  client only gets its empty fields filled.

### `licenses/{licenseId}` (+ `devices/{deviceId}`, `history/{id}`)
Existing fields (`licenseKey, customerName, businessName, phone, email, city, plan, status, maxDevices, maxFirms,
maxUsers, features, expiresAt, checkinDays, graceDays, notes, activeDevices, createdAt, updatedAt, createdBy`) plus
v1.1: `clientId, planType ('monthly'|'yearly'|'lifetime'), poweredBy (bool), detached (bool), detachedAt, detachedBy,
paymentStatus ('paid'|'partial'|'unpaid'|'none'), activatedAt, lastVerifiedAt`.
v1.2: `plan` and `planType` may be `'trial'` (portal "Issue trial": 1 computer, expiry +15 days editable, ≤ 90 days);
`devicesSummary: { [deviceId]: { deviceName, os, appVersion, status, activatedAt, activationType, statusNote } }` — a
denormalised copy of `devices/*` rewritten in the same transaction as every device change (absent on older licenses until
an admin with devices.manage backfills it), so the Devices page needs no read per license. Device approval is always an
explicit action of an admin with `devices.manage`, or (v1.3) instant self-registration with the activation pass within the
device limit (see `activationPasses`); an already active
computer is re-issued (no new slot); a full license needs "replace computer X" (release + approve in one transaction).

`status`: `active` | `suspended` | `revoked`. Pending = license with `activeDevices == 0` and no device ever activated.
Expired = `expiresAt` in the past (derived).

Delete license (owner only): removes `activationPasses/{sha256(key)}`, the history, released device records and answers
pending `activationRequests` for the key (`rejected`, deactivate requests `processed`); then one batch deletes the
license, `licenseStatus/{id}`, the active device records (rules: an active device record may only be deleted by the
owner once its license no longer exists after the write) and writes the `license_deleted` audit entry. Invoices are
kept. Activated computers keep their certificate but can no longer check in.

Remove device (`devices.manage`): a computer holding a slot is released first (slot freed, added to
`licenseStatus.deactivatedDevices`); then, optionally, its record is deleted, dropped from `devicesSummary`, and its
heartbeat for that license is deleted. It stays on the deactivated list.

### `activationPasses/{sha256hex(licenseKey)}` — public `get`, no `list` (v1.3, instant activation)
`licenseId, cert (activation code signed for deviceId '*'), updatedAt`. Written by the portal (`lib/activationPass.ts`,
`<PassSync/>`) whenever an admin with license rights has the signing key loaded: every active license gets one, re-signed when
its terms change (`licenses.passHash` = terms + key fingerprint), withdrawn when suspended / revoked. The desktop registers
itself with it: one commit that increments `licenses/{id}.activeDevices`, adds `devicesSummary[deviceId]` (activationType
`instant`), sets `selfActivatedDevice` and creates `devices/{deviceId}` (status active). The rules (`selfActivation`,
`selfDevice`) accept it only for an active, unexpired license with a free slot and a computer that has no device record and is
not in `deactivatedDevices`. Device records are readable by id (`get`) so the desktop can recognise its own registration.

### `licenseStatus/{licenseId}` — public `get`, no `list`
`status, expiresAt, deactivatedDevices: string[], poweredBy: bool, detached: bool, updatedAt,
certs: { [deviceId]: activationCode }`

`certs` carries re-signed certificates after a renewal, plan / limit change or lifetime detachment. The desktop
installs `certs[itsDeviceId]` at its next check-in when it verifies and differs from the installed one.

### `activationRequests/{id}`
Desktop creates: `type ('activate'|'deactivate'), licenseKey, licenseId, deviceId, deviceName, appVersion, os, status
('pending'), createdAt` and optionally (v1.1, registration) `companyName, ownerName, phone, address, installToken`.
Admin sets `status ('approved'|'rejected'|'processed'), certificate, message, processedAt, processedBy, licenseId`.

### `heartbeats/{installToken}` — desktop writes, admins read
`deviceId, licenseId ('' in trial), deviceName, os, appVersion, companyName, mode (license mode), lastCheckAt
(ISO string of the last successful license check, '' if none), firms (int), users (int), lastSeen (== request.time),
location?`

`location` (only when the customer enabled sharing): `{ lat, lng, accuracyKm, source ('device'|'approximate'|'manual'),
label, consent: true, updatedAt (ISO) }`. `device` = Windows location service (GPS / Wi-Fi positioning, with its
accuracy), only with the customer's consent and only when Windows location is enabled; `approximate` = derived from the
internet IP address — city level at best, often the ISP's gateway city (e.g. Lahore for a device in Burewala) — always
shown as approximate; `manual` = typed by the customer. The desktop never invents coordinates.

Online status (derived in the panel): **online** if `lastSeen` < 30 min ago, **recent** < 24 h, otherwise **offline**.
The desktop sends a heartbeat at start-up and every 15 minutes while online (≈ 96 writes/day/device, well inside
the Spark quota for a few hundred installations).

### `supportThreads/{installToken}` (+ `messages/{messageId}`)
Thread: `deviceId, licenseId, companyName, contactName, phone, status ('open'|'pending'|'resolved'), lastMessageAt,
lastMessageFrom ('customer'|'admin'), lastMessagePreview, unreadByAdmin, unreadByCustomer, createdAt`.
Message: `from ('customer'|'admin'), body (1–4000 chars), authorName, at (== request.time)`.
`messageId` for customer messages = the local `support_messages.uid` (makes retries idempotent).

### `invoices/{invoiceId}` (+ `payments/{paymentId}`)
`number, clientId, clientName, licenseId, planType, issueDate, dueDate, currency, lines [{ kind ('plan'|'extra_firm'|
'extra_device'|'other'), description, qty, rate, amount }], subtotal, discount, taxRate, taxAmount, total, paid,
balance, status ('unpaid'|'partial'|'paid'|'cancelled'), verifyToken, notes, createdAt, createdBy, updatedAt,
cancelledAt, cancelReason, lastPaymentAt`

Totals are computed by `src/lib/billing.ts` (unit tested). `overdue` is derived (`balance > 0 && dueDate < now`).
Payments are append-only: `amount, method, reference, date, receiptNo, createdAt, createdBy` (+ `cancelled,
cancelledAt, cancelledBy, cancelReason` to void one). Invoices are never deleted — they are cancelled.

### `publicInvoices/{verifyToken}` — public `get`, no `list`
`number, issuerName, issuerPhone, issuerEmail, issuerAddress, issuerLogo, customerName (masked per privacy setting),
issueDate, dueDate, currency, total, paymentStatus ('paid'|'partial'|'unpaid'), status ('valid'|'cancelled'),
lines [{ description, qty, amount }], updatedAt`

### `counters/{name}` — `invoices`, `receipts`, `clients`: `{ next: number }` (transactions)

### `settings/branding` (admins read, `branding.manage` writes) and `publicSettings/branding` (public get)
Private: `companyName, logo, signature, paymentQr, phone, email, address, website, bankName, bankTitle, bankAccount,
iban, currency, invoicePrefix, receiptPrefix, nextInvoiceNo, taxName, taxRate, invoiceFooter, terms, supportPhone,
supportWhatsapp, supportEmail, poweredByDefault, customerPrivacy ('full'|'masked'|'hidden'), verifyBaseUrl, mapTileUrl,
mapAttribution`. Public copy: `companyName, logo, phone, email, website, address`.

`settings/portal` (same rules): `sessionTimeoutMin` (admin inactivity sign-out, default 30).

### `auditLogs/{id}`
`action, category ('security'|'financial'|'license'|'client'|'device'|'support'|'settings'|'general'), by (email),
byUid, target, targetType, licenseId, details, meta, status ('success'|'failure'), at (== request.time), archived`

Retention: anyone with `audit.manage` may archive or delete activity entries of any age, except `security` entries,
which form the protected audit trail (sign-ins, permission changes and every log-clearing action) and can never be
deleted from the portal. License history entries and released (non-active) device records may also be cleared by
`audit.manage` / device managers; active devices never.

Rules test suite: `admin-panel/tests/rules.test.ts` (`npm run test:rules` in admin-panel; needs firebase-tools installed
globally — `npm i -g firebase-tools` — and Java).

## Known limits of the Spark-plan design (documented to customers)
* No server code ⇒ no true rate limiting. Auth sign-in brute force is throttled by Firebase Auth itself; license keys
  have ~8×10²⁴ combinations, so key guessing is infeasible; the Verify Key page throttles in the browser.
* Unauthenticated writes (activation requests, heartbeats, support messages) are shape- and size-checked by the rules
  but could be spammed; Firebase App Check can be enabled later without changing the data model.
* Multi-factor authentication requires Firebase Identity Platform (paid upgrade) — not enabled.

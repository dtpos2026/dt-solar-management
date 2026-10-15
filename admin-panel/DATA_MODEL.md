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

### `licenses/{licenseId}` (+ `devices/{deviceId}`, `history/{id}`)
Existing fields (`licenseKey, customerName, businessName, phone, email, city, plan, status, maxDevices, maxFirms,
maxUsers, features, expiresAt, checkinDays, graceDays, notes, activeDevices, createdAt, updatedAt, createdBy`) plus
v1.1: `clientId, planType ('monthly'|'yearly'|'lifetime'), poweredBy (bool), detached (bool), detachedAt, detachedBy,
paymentStatus ('paid'|'partial'|'unpaid'|'none'), activatedAt, lastVerifiedAt`.

`status`: `active` | `suspended` | `revoked`. Pending = license with `activeDevices == 0` and no device ever activated.
Expired = `expiresAt` in the past (derived).

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

`location` (only when the customer enabled sharing): `{ lat, lng, accuracyKm, source ('approximate'|'manual'),
label, consent: true, updatedAt (ISO) }`. `approximate` = derived from the internet IP address — always shown as
approximate. The desktop never sends GPS coordinates it did not get from the customer.

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

### `auditLogs/{id}`
`action, category ('security'|'financial'|'license'|'client'|'device'|'support'|'settings'|'general'), by (email),
byUid, target, targetType, licenseId, details, meta, status ('success'|'failure'), at (== request.time), archived`

Retention: anyone with `audit.manage` may archive. Only an owner may delete, only entries older than 90 days and
never `security`, `financial` or `license` entries.

## Known limits of the Spark-plan design (documented to customers)
* No server code ⇒ no true rate limiting. Auth sign-in brute force is throttled by Firebase Auth itself; license keys
  have ~8×10²⁴ combinations, so key guessing is infeasible; the Verify Key page throttles in the browser.
* Unauthenticated writes (activation requests, heartbeats, support messages) are shape- and size-checked by the rules
  but could be spammed; Firebase App Check can be enabled later without changing the data model.
* Multi-factor authentication requires Firebase Identity Platform (paid upgrade) — not enabled.

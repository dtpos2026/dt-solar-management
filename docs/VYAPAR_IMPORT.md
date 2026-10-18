# Importing a Vyapar backup (.vyb)

A Vyapar backup (`.vyb`) is a ZIP archive containing one SQLite database (`.vyp`). DT Solar Pro converts it into its
own **JSON backup (`.js1`)** — no live data is touched until you restore the converted file.

## In the app
1. Backup & Restore → **Import from Vyapar (.vyb)** → *Convert a Vyapar backup…* → pick the `.vyb`, choose where to save the `.js1`.
2. The result shows how many reconciliation checks passed and any warnings. *Open report* shows the full report (saved next to the `.js1`).
3. *Restore this converted backup…* → leave **Keep my current users, passwords and settings** ticked → type `RESTORE`. A safety copy of the current data is saved first.
4. Sign in with **your existing password**. Nothing else is asked.

### Why a password used to be asked after restoring a converted backup
A Vyapar `.vyb` is a plain ZIP with a plain SQLite database: it is **not encrypted and has no backup password** (Vyapar's own app passcode is stored as a normal
setting, and is empty or off in most files). Vyapar has no exportable password, so the converted file only held a one-off *temporary* owner password, and a restore
replaces every account. The owner's existing password was not in the file, so it failed, and the temporary one forced a change.
Now the owner who restores (already signed in, and confirming with `RESTORE`) keeps this installation's accounts: the PBKDF2 hashes are copied as they are (no plain
text is read, shown, stored or reset), roles are matched by name, users limited to specific firms are carried over **disabled** until firms are assigned (the converted
firms have new ids), and the computer's own settings (automatic backup, backup folder, auto-lock, printers, WhatsApp, location consent) are kept. If automatic backup
was off it is switched on, as it was in Vyapar. Automatic backup runs from the schedule alone and never asks for a password.
On a computer with no owner yet, or with the option unticked, or when the `.dtbak` is restored with the normal restore, the temporary password in the report applies.

The `.js1` checksum covers every table: editing it by hand breaks the checksum and the restore is refused; regenerate it with the converter instead.
A Vyapar passcode, delete PIN or payment-link token that **is** set is not copied into the archive (the row stays, the secret does not).

## Command line (same converter, also creates a `.dtbak` and CSV audit files)
```
npx vite-node scripts/convert-vyapar.ts -- <backup.vyb> <output-folder> [--password <temporary password>]
```
Outputs: `<name>_DTSolarPro.js1`, `<name>_DTSolarPro.dtbak`, `conversion-report.md`, `validation.json`,
`id-map.csv`, `number-changes.csv`, `notes.csv`. The run also restores the `.js1` twice into scratch databases and
checks that the data is identical (SHA-256) and that every reconciliation check still passes.

## What is converted (summary)
Firms (logo, signature), parties (+ opening balances), items, sales invoices, purchase bills, estimates (and their
conversion to invoices), item lines with item descriptions, payment-in / payment-out, amounts paid at billing,
payment discounts (as party adjustments linked to the bill), expenses, cash / bank accounts, stock (posted through the
app's stock engine), numbering prefixes, terms, custom fields (into notes). **Every row of every Vyapar table** is also
kept verbatim in the `legacy_records` table, and changed ids are listed in `legacy_id_map`.

Known limits: Vyapar cheque clearing, loan accounts, chart-of-accounts, message templates and audit trails have no
equivalent module — they are kept in the legacy archive only. Payments that Vyapar links to an *opening balance* or
to *another payment* stay unallocated (party balances are exact).

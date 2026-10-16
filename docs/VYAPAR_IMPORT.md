# Importing a Vyapar backup (.vyb)

A Vyapar backup (`.vyb`) is a ZIP archive containing one SQLite database (`.vyp`). DT Solar Pro converts it into its
own **JSON backup (`.js1`)** — no live data is touched until you restore the converted file.

## In the app
1. Backup & Restore → **Import from Vyapar (.vyb)** → *Convert a Vyapar backup…* → pick the `.vyb`, choose where to save the `.js1`.
2. The result shows how many reconciliation checks passed, any warnings, and the **temporary owner password**.
   *Open report* shows the full report (saved next to the `.js1`).
3. *Restore this converted backup…* → type `RESTORE`. A safety copy of the current data is saved first.
4. Sign in as **admin** with the temporary password; you must set a new password.

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

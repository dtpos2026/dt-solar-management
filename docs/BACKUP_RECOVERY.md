# Backup and recovery (DT Solar Pro v1.5)

## What is backed up
* **Database backup (.dtbak)**: a verified copy of the whole database (all firms, users, documents, payments, stock, settings). Created by Backup and Restore, automatically every day (`Documents\DT Solar Pro Backups`), at every Day Closing, and before every restore.
* **JSON backup (.js1)**: the same data as readable JSON with a checksum. Use it to move to another computer or to keep a portable copy.
* **CSV export**: one file per list (customers, suppliers, products, sales, purchases, payments, expenses). For spreadsheets and re-import. Accounts and users are not part of CSV.

## Safety copies made for you
| Before this action | Copy that is saved |
|---|---|
| Restoring a backup | `Backups\safety\` (full database, `pre-restore`) |
| Closing a day or month | `Backups\day-close\` |
| Removing audit log entries | `Backups\audit-log\audit-log-removed-<time>.csv` (and a full database backup in `Backups\safety\` when the whole log is emptied) |
| Deleting an account, user or firm | Nothing is deleted if it has records. Take a backup first when unsure. |

## Restore
1. Backup and Restore, pick the file, **Verify** (integrity and checksum are checked and a damaged file is refused).
2. **Restore**. The app saves a safety copy of the current data first, replaces the database and restarts.
3. Check the dashboard and Day Closing figures. If the restore was a mistake, restore the `pre-restore` file from `Backups\safety\`.

## New computer
Install DT Solar Pro, finish the first-run wizard with the licence, then Restore the `.dtbak` or `.js1` file. The licence is tied to the computer: ask Digital Target to release the old computer or approve the new one (the Super Admin panel does it in seconds).

## If a computer is blocked by Digital Target
The screen explains the reason and offers **Contact Digital Target**. Your data is never deleted. A backup of your own data still works while blocked. When Digital Target reactivates the computer it unlocks by itself (usually within a minute) or press **Check again**.

## Super Admin panel
* Licence signing key: keep `keys\license-private.pem` on a USB drive. Without it new licences cannot be signed and installers already given to customers cannot be re-keyed.
* Firestore data: export with `gcloud firestore export` or the Firebase console on a schedule. The "Clear all" actions never delete the security trail (archived instead).

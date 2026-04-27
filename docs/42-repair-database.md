# 42. Database Repair

Companion to [7. Backup & Restore](7-backup-restore.md). Surfaces a manual repair flow in **Settings → Backups** for cases where the live `db/` directory failed to open and was renamed aside as `db-corrupt-<TS>` (HS-7888 last-resort), or when the user simply wants to validate that their backups are still loadable.

## Functional Requirements

### 42.1 Status Pill

Settings → Backups gets a "Database Repair" subsection with a single-line status pill at the top:

- **Healthy** — green pill, text: "Database is healthy ✓".
- **Recovered** — red pill, text: "⚠ Database recovery occurred at YYYY-MM-DD HH:MM:SS — see banner above the toolbar".

The pill reads from the recovery marker via `GET /api/db/recovery-status` (introduced in HS-7899). It refreshes every time Settings opens.

### 42.2 Find a Working Backup

Primary action button: **Find a working backup**. Calls `POST /api/db/repair/find-working-backup`. The server iterates `listBackups(dataDir)` newest-first and validates each tarball by attempting `loadDataDir` into a temp PGLite instance. The first tarball that loads successfully is returned with its tier, filename, ticket count, and createdAt timestamp.

The client surfaces this inline:

> ✓ Found `backup-2026-04-21T...Z.tar.gz` (daily, 639 tickets, created 2026-04-21 05:00:00). [Restore from this backup]

Clicking Restore opens a confirmation dialog (with the existing safety-backup-first semantics) and reuses the existing `POST /api/backups/restore` flow.

If no tarball loads, the client shows a red error label and points the user at the pg_resetwal flow as the next-best option.

### 42.3 Run pg_resetwal

Secondary action button: **Run pg_resetwal…**. Two-step flow:

1. **Availability probe.** `GET /api/db/repair/pg-resetwal-availability` returns `{ available, path, platform, installInstructions }`. The server probes a list of platform-specific candidate paths (PATH first, then known install locations) by spawning `pg_resetwal --version`.

2. **If available**, the user gets a confirmation dialog explaining what will happen:
   - Copy the corrupt directory (`marker.corruptPath`) to a temp location.
   - Run `pg_resetwal -f` on the copy.
   - Re-dump the repaired directory as a new tarball in the 5-min backup tier.
   - The original corrupt directory and the live `db/` are untouched.

   On confirm, `POST /api/db/repair/run-pg-resetwal` does the work (server-side) and returns `{ tier, filename, ticketCount, sizeBytes }` for the new tarball. The backup list refreshes; the user can click "Restore from this tarball" to use it.

3. **If not available**, the client shows a platform-aware install dialog:
   - **macOS**: "macOS (via Homebrew)" + `brew install postgresql@17` + link to https://www.postgresql.org/download/macosx/
   - **Linux**: `sudo apt install postgresql-17` (Debian/Ubuntu) and `sudo dnf install postgresql17` (Fedora/RHEL) + link.
   - **Windows**: "Download the EnterpriseDB installer for PostgreSQL 17" + link to https://www.postgresql.org/download/windows/
   - **Other**: generic download link.

   The dialog tells the user to retry once `pg_resetwal` is on PATH.

### 42.4 Auto-Mitigation Boundary

Per the HS-7897 feedback (Q5 = `(ii)(a)`):

- **Auto-attempted at open time:** drop a stale `postmaster.pid` and retry. Already shipped in HS-7888; no code change.
- **User-initiated only:** every other mitigation (find-working-backup, pg_resetwal). The app never silently runs anything destructive.

## Non-Functional Requirements

### 42.5 Cross-Platform

`pg_resetwal` discovery and install instructions cover **macOS / Linux / Windows** out of the box. `candidatePgResetwalPaths(platform)` and `installInstructions(platform)` are pure helpers in `src/db/repair.ts` covered by per-platform unit tests so adding a new platform doesn't silently regress an existing one.

### 42.6 Safety

- The corrupt directory is copied to a temp location *before* `pg_resetwal` runs. The original is never modified.
- The repaired tarball goes into the 5-min tier alongside auto-backups, so the standard restore flow handles it. Restore creates a safety backup first per §7.5.
- The live `db/` is not modified by either flow until the user explicitly clicks Restore.
- pg_resetwal is gated on a recovery marker — if no marker exists, the route returns 400 to prevent accidental use against a healthy DB.

### 42.7 Out of Scope (Future Tickets)

- **Vendored WASM `pg_resetwal`** — would let Hot Sheet repair without any system Postgres install. Bigger scope (Rust/WASM build pipeline + binary size hit). Tracked in HS-7901 follow-up.
- **In-place swap** of the repaired directory — currently the user has to click Restore manually. Auto-swap is risky because the live PGLite instance would need to be re-bound to a different directory. Tracked separately if pain accumulates.
- **Repair against a hand-picked directory** — current flow always operates on `marker.corruptPath`. A directory picker UI is deferred until users actually need to repair something else.

## Implementation

- `src/db/repair.ts` — `findWorkingBackup`, `getResetwalAvailability`, `runResetwalAndDump`, plus the pure `installInstructions(platform)` and `candidatePgResetwalPaths(platform)` helpers.
- `src/routes/db.ts` — three new endpoints: `POST /repair/find-working-backup`, `GET /repair/pg-resetwal-availability`, `POST /repair/run-pg-resetwal`.
- `src/routes/pages.tsx` — Database Repair subsection inside the Backups settings panel.
- `src/client/dbRepairUI.tsx` — `bindDbRepairUI`, `refreshDbRepairStatus`, plus the pure formatters `formatStatusText` + `formatInstallHelp`.
- `src/client/backups.tsx` — calls `bindDbRepairUI()` from `bindBackupsUI()` and `refreshDbRepairStatus()` from `loadBackupList()`.
- `src/client/styles.scss` — `.db-repair-status`, `.db-repair-actions`, `.db-repair-result` rules.

## Tests

- `src/db/repair.test.ts` — `installInstructions` per platform, `candidatePgResetwalPaths` per platform, `findWorkingBackup` integration (skips broken tarballs, returns null when none).
- `src/routes/db.test.ts` — `/repair/find-working-backup` shape, `/repair/pg-resetwal-availability` shape, `/repair/run-pg-resetwal` 400-without-marker gate.
- `src/client/dbRepairUI.test.ts` — `formatStatusText` healthy / recovered branches, `formatInstallHelp` cross-platform copy preserves multi-line apt+dnf and the EnterpriseDB hint.

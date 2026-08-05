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

   **The major version has to match (HS-9578).** `pg_resetwal` refuses a cluster written by a different PostgreSQL major outright — `pg_resetwal: error: data directory is of wrong version` — so "the binary runs" was never the right question. `getResetwalAvailability` parses the major out of `--version` and **skips** a candidate that does not match, falling through to the version-pinned paths. Given a candidate directory it compares against *that cluster's* `PG_VERSION`, so a preserved directory written by an older PGLite still matches the right binary; otherwise it uses `PGLITE_PG_MAJOR` (17). An unparseable `--version` is accepted rather than rejected — an unfamiliar packaging format must not disable repair, and the repair itself will surface the real error.

   Before this, the bare `pg_resetwal` candidate (tried first) won on any machine whose PATH Postgres was a different major — the common case, since Homebrew's `postgresql` formula is 18 — and the panel reported "available" while pointing at a binary that could never work. Because `probeCorruptCluster` reports an unopenable candidate as `null`, the user saw every candidate stuck on "checking…" with no error anywhere.

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

### 42.3a Choosing WHICH preserved database to repair (HS-9575)

Repair used to operate on exactly one directory: the `corruptPath` inside
`.db-recovery-marker.json`. That marker is written at the **end** of
`recoverFromOpenFailure`, so a recovery that dies partway (§73.7b / HS-9572) leaves the
**previous** incident's marker in place. On 2026-08-04 that marker named a **0-byte**
directory while the one holding 432 tickets sat beside it — present on disk, unreferenced,
and impossible to select from the UI. The project had five `db-corrupt-*` directories and
the flow could only ever offer the wrong one.

So repair now **enumerates instead of assuming**:

- `GET /db/repair/corrupt-clusters` lists every `db-corrupt-*` in `dataDir`, newest first,
  with mtime, size, and whether it looks like a cluster at all (`PG_VERSION` present — the
  0-byte case is shown as "not a database (nothing to recover)" rather than silently
  offered). Metadata only, so the picker renders immediately.
- `POST /db/repair/probe-corrupt-cluster` answers the question that actually decides it:
  **how many tickets would this one yield?** It runs the real recovery — copy →
  `pg_resetwal -f` → open → `COUNT(*)` — against a temp copy and throws the result away.
  The client probes candidates one at a time (each copies a whole cluster, so running them
  concurrently multiplies disk and CPU for no earlier answer) and rewrites each row as its
  number lands.
- `POST /db/repair/run-pg-resetwal` now accepts `{ corruptPath }`. The picker defaults to
  the candidate with the **most recoverable tickets** rather than whichever directory a
  marker happens to name. Omitting the field keeps the old marker-derived behavior.

**The path is not trusted.** A client-supplied `corruptPath` reaches `cpSync` and
`pg_resetwal`, so `resolveCorruptCluster` resolves it and requires an **exact match against
an enumerated candidate**. A `startsWith` check on the raw string would admit both a
traversal and an unrelated directory that merely shares the name prefix; both are pinned as
tests.

**Coverage (HS-9578).** The server half is unit-tested in `src/db/repair.test.ts`;
the client half is `e2e/db-repair-candidate-picker.spec.ts`. The listing, the
not-a-database marking, the default selection, and Cancel run everywhere — they
stub `/probe-corrupt-cluster` and the availability gate so the counts are
deterministic. A fourth, separately gated test does the whole thing for real:
two genuine clusters seeded at different ticket counts, real probes, a real
repair, and an assertion that the resulting tarball carries the **selected**
candidate's count. Its gate is the server's own probe against a seeded
candidate rather than "is the binary present", so a machine that cannot actually
recover a cluster skips honestly instead of failing.

Writing that test found the picker had **never worked** — see HS-9587: the two
path-taking callers in `src/api/db.ts` pre-encoded their request bodies (the
transport stringifies `opts.body` itself, so the server received a JSON *string*
and 400'd), and the availability probe accepted a wrong-major binary. Both are
fixed; the seam between a green server half and an untested client half is
exactly where they lived.

### 42.3b Repair is an ACTION, not a setting (HS-9588)

The Database Repair section must stay **outside** the `[data-scope-complex]`
wrapper that the docs/95 scope bar locks.

It was inside it, together with the Snapshot Protection toggle, and
`[data-scope-complex].scope-locked` sets `pointer-events: none`. **Local is the
default scope**, and Local is a locked mode — so every repair control was inert
for a real user: both buttons, and everything the flow renders into
`#db-repair-result`, including the §42.3a candidate picker and its Restore
buttons. Clicks landed on the panel behind them and nothing happened.
`document.elementFromPoint` at a button's own center returned
`.settings-tab-panel`.

The distinction the original grouping missed: the snapshot toggle is a **setting**
(`db_snapshot_protection`) with real per-layer semantics, so locking it in a view
where it cannot be edited is correct. Repair is an **action** — there is no
local-versus-shared version of "recover my database" — and it is the one surface
a user reaches precisely when their data is already broken.

Guarded by two tests in `e2e/db-repair-candidate-picker.spec.ts`: one waits for
the lock to be **active** and then asserts the repair buttons still receive
pointer events (measuring `elementFromPoint`, not clicking — a click that does
nothing is the failure being guarded), and one asserts the snapshot toggle is
still inside the wrapper, so the fix cannot over-correct and let a Local-scope
edit write a shared setting. The rest of that spec clicks positionally for the
same reason.

The picker's `<select>` also gained `max-width: 100%`, and `describeCandidate`
now leads with the recoverable count: a `<select>` clips options from the right,
so the one number the choice is made on was the first thing to disappear.

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

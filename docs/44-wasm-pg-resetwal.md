# 44. WASM `pg_resetwal` (Design Spike)

HS-7901. Follow-up to [42. Database Repair](42-repair-database.md). Investigates whether Hot Sheet can ship its own WASM-compiled `pg_resetwal` so the §42 repair flow no longer depends on a system Postgres install.

> **Status:** Design only. No code under this ticket.
> **Verdict:** Defer. Recommend continuing to lean on the §42 system-binary path for now and re-visit after PGLite upstream's `cli` mode lands. See §44.6 for the decision rationale.

## 44.1 Problem statement

§42's "Run pg_resetwal…" button shells out to a `pg_resetwal` binary discovered via PATH + a per-platform candidate list (Homebrew + Postgres.app on macOS, `/usr/lib/postgresql/17/bin` + `/usr/pgsql-17/bin` on Linux, `C:\Program Files\PostgreSQL\17\bin` on Windows). When the binary is missing, the dialog surfaces a platform-aware install hint with `brew install postgresql@17` / `apt install postgresql-17` / EnterpriseDB download.

That coverage is fine for developers but cracks for:

- **Locked-down machines** where the user can't install postgresql@17 (no admin, locked package manager, sandboxed corp environment).
- **Tauri desktop builds** that can't bundle `pg_resetwal` directly because the binary is platform/version-specific (different binaries for arm64 macOS, x86_64 macOS, Debian glibc, RHEL, Win32, plus matching the running PGLite's PostgreSQL major version).
- **One-click recovery UX**, where the extra "go install Postgres" step erodes trust in the repair button.

The §42 flow itself remains valuable — pg_resetwal is the right tool for "rewrite `pg_control` to a fresh checkpoint and zero the WAL". The question is whether we can ship it ourselves.

## 44.2 Options surveyed

### Option 1 — Extend PGLite's WASM bundle to also export `pg_resetwal`

PGLite ships PostgreSQL 17 compiled to WASM via Emscripten (~8.9 MB single `pglite.wasm`). The PostgreSQL source tree includes `src/bin/pg_resetwal/pg_resetwal.c`. Conceptually `pg_resetwal_main()` could be exported from the same `.wasm` module since most of its dependencies are already linked into the postgres core.

**Pros:**
- Zero extra binary in the dist if the export is added without duplicating code.
- Shares PGLite's existing memfs ↔ host-fs bridge (`dumpDataDir` / `loadDataDir`) — disk I/O Just Works.
- Stays in lockstep with PGLite's PostgreSQL version (no version-mismatch class of bug).

**Cons:**
- Requires forking + maintaining a patched PGLite build, OR upstreaming the change. PGLite is actively developed but they've signaled preference for keeping the WASM module focused on the running postmaster, not utility binaries. Issue tracker has occasional asks for `pg_dump` / `pg_resetwal` but no roadmap commitment as of this spike.
- Emscripten linker tuning: `pg_resetwal` and `postgres` share enough code that LTO may already strip the extra symbols; if not, exporting `_pg_resetwal_main` could pull in extra code paths on top of the 8.9 MB baseline. Hard to estimate without prototyping.
- Build pipeline complexity: PGLite's release process is upstream's; we'd need either to fork their CI or wait on their release cadence.

**Estimate:** 1–2 weeks if we fork. 2–3 months if we upstream and wait for a release. Binary-size delta: probably <500 KB given LTO, but unverified.

### Option 2 — Standalone WASM `pg_resetwal` built from postgres source

Compile `src/bin/pg_resetwal/*.c` against a minimal subset of postgres headers as its own Emscripten target. Ship as a separate `dist/pg-resetwal.wasm` loaded only when the §42 repair button is clicked.

**Pros:**
- Doesn't touch PGLite's bundle — independent versioning + release.
- Lazy-loaded: zero cost for users who never trigger the repair flow.
- Can pin to PostgreSQL 17 to match PGLite (the `pg_control` struct + WAL format are stable per major version).

**Cons:**
- Highest implementation cost. Have to set up an Emscripten build pipeline, vendor a slice of the postgres source, write our own filesystem shim, ship CI.
- Estimated binary size: 1–2 MB raw, 300–500 KB gzipped (extrapolated from `pg_resetwal`'s ELF size on Linux + typical Emscripten overhead). Not free but acceptable for a tool that runs once per recovery event.
- Version-locking risk: if PGLite ever bumps to PostgreSQL 18, our standalone bundle has to follow. The §42 system-binary path side-steps this because the user installs the matching version of system postgres.

**Estimate:** 3–5 weeks of focused work for a v1 that can rewrite `pg_control` against `<dataDir>` extracted via PGLite's `dumpDataDir` API.

### Option 3 — Re-implement the relevant `pg_resetwal` logic in TypeScript

`pg_resetwal -f` does a small, well-defined job: rewrite `<dataDir>/global/pg_control` to point at a fresh checkpoint LSN and zero the WAL segment files. The `pg_control` struct is `ControlFileData` from `src/include/catalog/pg_control.h` — fixed layout per major version.

**Pros:**
- Smallest dist hit (a few hundred lines of TS, no WASM).
- No build-pipeline dependency on Emscripten.
- Hot-loadable, debuggable in the browser DevTools.

**Cons:**
- Format-locked to a specific PostgreSQL major version; PGLite version bumps could silently break the implementation if the struct layout shifts.
- Have to faithfully reproduce checksum logic (CRC-32C over the control file) plus the LSN math for the new redo pointer. Easy to get wrong; one-off-by-one bug = unrecoverable cluster.
- No upstream confidence: `pg_resetwal` itself has accumulated edge-case fixes over decades (handling of corrupted `pg_control`, fallback to scanning WAL segments). A TS port would carry only the happy path.
- Test surface is thin without a way to spin up a known-corrupt cluster on CI.

**Estimate:** 2–3 weeks of risk-heavy work, very low confidence that the result handles unusual corruption shapes.

### Option 4 — Don't ship; rely on the §42 system binary

Status quo: keep the §42 repair button, keep the cross-platform install hint. Evangelise `brew install postgresql@17` etc.

**Pros:**
- Zero engineering cost.
- Leverages a well-tested binary that the postgres community maintains.
- No version-skew risk.

**Cons:**
- The original problem from §44.1 remains: locked-down machines, Tauri-only users, one-click UX.

## 44.3 Comparative summary

| Dimension                    | 1: Patch PGLite bundle | 2: Standalone WASM | 3: TS port  | 4: System binary |
|------------------------------|------------------------|--------------------|-------------|------------------|
| Engineering cost             | Medium                 | High               | Medium      | Zero             |
| Binary-size hit              | <500 KB (likely)       | 300–500 KB gz      | <10 KB      | 0                |
| Lock-in to PG major version  | Auto-tracks PGLite     | Manual             | Manual      | None             |
| Fragility                    | Low                    | Low                | High        | Low              |
| Ships without admin install  | Yes                    | Yes                | Yes         | No               |
| Tauri-only-friendly          | Yes                    | Yes                | Yes         | No               |
| Time-to-value                | 1–2 wk fork; 3 mo upstream | 3–5 wk         | 2–3 wk      | Already shipped  |

## 44.4 Filesystem shim

Whichever WASM option is chosen, the host-side glue is the same:

1. Read the live (or `db-corrupt-<TS>`) data directory off disk into a memfs buffer (similar to `dumpDataDir` but reading raw, not gzipped).
2. Mount the buffer into the Emscripten runtime's virtual FS at `/data`.
3. Call `pg_resetwal_main(["pg_resetwal", "-f", "/data"])` (or the equivalent exported entry point).
4. Walk the post-run memfs and write the modified files back to `<dataDir>` on disk.

PGLite already implements steps 1+2 (`loadDataDir`) and the inverse (`dumpDataDir`). Reusing those helpers cuts the shim implementation to a thin wrapper.

## 44.5 Sandboxing

WASM in Node.js / Tauri runs without elevated permissions. The shim has no need to spawn a child process or call privileged syscalls — the entire repair runs inside the WASM sandbox plus a single `writeFileSync` per modified file in the dataDir. That's strictly safer than the §42 system-binary path, which requires the user to grant Hot Sheet permission to spawn `pg_resetwal`.

## 44.6 Recommendation

**Defer.** Keep the §42 system-binary repair flow as the primary path. Re-evaluate when:

1. **PGLite upstream ships `cli` / utility-binary support.** Several issue threads track this; if upstream lands `pg_resetwal` as a first-class export, Option 1 collapses to a `npm update` with no fork to maintain.
2. **A user actually hits the no-admin / Tauri-only wall.** Today no incident has surfaced in HS-7891–7894 from a user who couldn't install postgresql@17. The cost-vs-value calculus tips the other way once a real user is blocked.

If we have to act sooner, the recommendation is **Option 2 (standalone WASM)** over Options 1 and 3:

- Beats Option 1 on time-to-value (no upstream gatekeeper).
- Beats Option 3 on safety (using the actual postgres source, not a hand-port).
- Lazy-loaded so the binary-size hit only lands for users who actually need recovery.

## 44.7 Cross-references

- §42 — Database Repair: the system-binary path Option 4 maintains.
- §7 — Backup & Restore: §7.7 hardening + §7.8 disaster-recovery runbook (the manual `pg_resetwal` flow this would automate further).
- §41 — Backup JSON co-save: orthogonal escape hatch; if `pg_resetwal` (in any form) fails, the JSON is still the rescue artifact.
- HS-7891 incident retro — original motivation.

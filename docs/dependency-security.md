# Dependency Security & Auditing

How Hot Sheet keeps its dependencies current and screened for known
vulnerabilities. Hot Sheet ships from three dependency ecosystems, and all
three are covered:

- **npm** — the published `hotsheet` package (`dist/` + the Tauri-bundled Node
  sidecar's `node_modules`).
- **cargo** — the Rust/Tauri desktop crate under `src-tauri/`.
- **github-actions** — the workflow files themselves.

## Automated auditing (HS-8601)

`.github/workflows/security-audit.yml` runs on every pull request, on push to
`main`, on a weekly schedule (Mondays), and on demand (`workflow_dispatch`). It
is a **dedicated** workflow, not a job inside `release-candidate.yml`, because
the release workflow only triggers on `v*-rc.*` / `v*-beta.*` tags — it could
only catch an advisory at release time, whereas advisories are disclosed
independently of our release cadence.

Two jobs:

- **`npm-audit`** — `npm audit --omit=dev --audit-level=high`. Production tree
  only: the dev toolchain (eslint, vitest, nyc, sass, tsup, esbuild, …) never
  ships, so `--omit=dev` keeps the signal on what actually ends up in `dist/`
  and the sidecar. **Blocking** as of HS-8602 (the production tree is clean — see
  the baseline note below).
- **`cargo-audit`** — `cargo audit` against `src-tauri/Cargo.lock` via the
  RustSec advisory DB. Before HS-8601, nothing screened the shipped desktop
  binary's crates at all. Still **non-blocking** (`continue-on-error: true`):
  HS-8602 was npm-scoped, so the Rust baseline hasn't been triaged + cleared
  yet; that's a follow-up before flipping this job to blocking too.

## Dependabot (HS-8601)

`.github/dependabot.yml` opens weekly dependency-update PRs for all three
ecosystems. Minor + patch updates are **grouped** per ecosystem so routine
bumps arrive as one reviewable PR; major bumps open individually so a breaking
change gets its own review.

## The current baseline & the "reachability" triage rule (HS-8592 / HS-8602)

The HS-8592 audit reported a scary-looking ~55 (30 moderate / 25 high), but most
of it was noise. **HS-8602 cleared it.** A plain `npm update` (semver-compatible
bumps only — no `--force`) pulled the in-range fixes and dropped the count to **3
moderate / 0 high**:

- `@modelcontextprotocol/sdk` 1.27.1 → 1.29.0, which in turn upgraded the bundled
  Express 5 transitive stack (`path-to-regexp` → 8.4.2, `qs` → 6.15.2), clearing
  the bulk of the high-severity production advisories.
- The genuinely reachable production items: `ws` 8.20.0 → 8.21.0,
  `marked` 18.0.0 → 18.0.4 (plus `hono` 4.12.7 → 4.12.23).

After the bumps:

- **`npm audit --omit=dev --audit-level=high` reports 0 vulnerabilities** — the
  production gate now passes on a clean baseline, so its job is **blocking**.
- The only residual advisories are **3 moderate dev-only** items in the
  `nyc` → `istanbul-lib-processinfo` → `uuid` coverage chain. They are excluded
  by `--omit=dev` and below the `--audit-level=high` threshold, so they don't
  gate. npm's only offered fix is a `--force` downgrade to `nyc@14.1.1` (a
  breaking major rollback), which is not worth taking for a dev-only,
  never-shipped coverage tool. No `audit-ci`/allowlist file is needed — the
  gate's `--omit=dev --audit-level=high` scope already excludes them.

**Triage rule:** before treating a production advisory as actionable, confirm
the vulnerable code path is actually reachable from Hot Sheet's own code.
Unreachable transitive advisories (dead-code transports — e.g. the MCP SDK's
bundled Express 5 stack, which Hot Sheet never instantiates because
`src/channel.ts` uses Node's raw `createServer` + the MCP SDK `Server` class)
should be recorded with a short justification rather than chased. When the
production gate goes red, either upgrade to a fixed version or — if the advisory
is provably unreachable — document the justification here before merging.

## Running the audits locally

```bash
npm audit --omit=dev --audit-level=high     # production npm tree
npm audit                                   # everything, incl. dev toolchain
cargo audit                                 # from src-tauri/ (needs cargo-audit)
```

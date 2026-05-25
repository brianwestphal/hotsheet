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
  only: roughly 40 of the ~55 current advisories are dev-toolchain (eslint,
  vitest, nyc, sass, tsup, esbuild, …) that never ship, so `--omit=dev` keeps
  the signal on what actually ends up in `dist/` and the sidecar.
- **`cargo-audit`** — `cargo audit` against `src-tauri/Cargo.lock` via the
  RustSec advisory DB. Before HS-8601, nothing screened the shipped desktop
  binary's crates at all.

Both jobs are currently **non-blocking** (`continue-on-error: true`) — see the
baseline note below.

## Dependabot (HS-8601)

`.github/dependabot.yml` opens weekly dependency-update PRs for all three
ecosystems. Minor + patch updates are **grouped** per ecosystem so routine
bumps arrive as one reviewable PR; major bumps open individually so a breaking
change gets its own review.

## The current baseline & the "reachability" triage rule (HS-8592 / HS-8602)

`npm audit` reports a scary-looking count (~55: 30 moderate / 25 high as of the
HS-8592 audit), but most of it is noise, and the audit jobs stay non-blocking
until that's cleaned up under **HS-8602**:

- **~40 are dev-only** — build/test toolchain, never shipped. `--omit=dev`
  drops them.
- The headline **high-severity production advisories are unreachable**: the MCP
  SDK (`@modelcontextprotocol/sdk`) bundles an Express 5 stack (`express`,
  `body-parser`, `qs`, `router`, `path-to-regexp`, `express-rate-limit`, all
  DoS/ReDoS), but **Hot Sheet never imports `express`** — `src/channel.ts` uses
  Node's raw `createServer` plus the MCP SDK `Server` class, so that transport
  is never instantiated.
- The genuinely reachable production items (`ws`, `marked`) are low-risk on a
  localhost-bound single-user tool and have in-range fixes.

**Triage rule:** before treating a production advisory as actionable, confirm
the vulnerable code path is actually reachable from Hot Sheet's own code.
Unreachable transitive advisories (dead-code transports, etc.) should be
recorded with a short justification rather than chased. Once HS-8602 lands the
`npm update` + `npm audit fix` + triage that yields a clean/justified baseline,
flip `continue-on-error` off in `security-audit.yml` so the gate becomes
blocking.

## Running the audits locally

```bash
npm audit --omit=dev --audit-level=high     # production npm tree
npm audit                                   # everything, incl. dev toolchain
cargo audit                                 # from src-tauri/ (needs cargo-audit)
```

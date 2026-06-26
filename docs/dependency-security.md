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
  binary's crates at all. **Blocking** as of HS-8649 (the Rust baseline is clean
  at the `vulnerability` level — see the cargo baseline note below). Plain
  `cargo audit` fails only on `vulnerability` advisories; `unmaintained` /
  `unsound` advisories surface as non-failing warnings (the workflow does NOT
  pass `--deny warnings`), so the residual informational warnings documented
  below don't gate.

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

## Security-sensitive production deps

### `node-forge` (HS-8992 — mTLS CA + cert lifecycle)

The strong-remote-auth epic (§94 / HS-8985) needs to **build/sign X.509 certs, generate/sign
CSRs, and export PKCS#12 (`.p12`)** — none of which Node's built-in `crypto` can do (it generates
keypairs + *parses* X.509 only). `src/auth/ca.ts` (HS-8992) uses **`node-forge@^1.3.1`** for these.

- **Why this lib:** a single, mature, widely-used pure-JS package covering all three operations in
  one dependency (the alternative, `@peculiar/x509`, needs `@peculiar/asn1-pkcs12` + manual
  assembly for the `.p12` half). Pure JS → bundles into the server tsup output with no native-addon
  or runtime-external handling.
- **Posture:** `npm audit` reports **no advisories against `node-forge@1.3.1`** (checked
  2026-06-24). It is on the security-critical path (it mints the certs that authenticate remote
  clients), so it is a standing item for the HS-8987 release-time security re-audit and should be
  kept current with any future forge advisories. Native `crypto.generateKeyPairSync` does the
  actual keygen; forge is used only for cert assembly / signing / PKCS#12 encode/decode.

### `qrcode` (HS-9026 — mTLS device-pairing QR)

The QR-pairing UI (§94.4.2 Phase 2 / §97.3) encodes a single-use pairing token + reachable URL into a
QR the operator's phone scans. `src/client/devicesPairing.tsx` uses **`qrcode@^1.5.4`** (`toDataURL`)
to render it; `@types/qrcode` is a devDependency.

- **Why this lib:** the standard, mature pure-JS QR encoder; bundles into the client IIFE with no
  native addon. **Client-only, render-only** — it encodes a string we already produced; it parses no
  untrusted input and isn't on the cert-signing path.
- **Posture:** `npm audit` reports **no advisories against `qrcode@1.5.4`** (checked 2026-06-25; its
  transitive deps `dijkstrajs`/`pngjs`/`yargs` are clean). Not security-critical (the *token* it
  encodes is what's gated — single-use + short TTL, server-side, HS-8996).

### `@zxing/browser` + `@zxing/library` (HS-9097 — in-page QR scanner)

The device-side `/pair` page (§94.4.2 Phase 2) decodes the operator's pairing QR with the phone's
camera. `src/client/pair.tsx` uses **`@zxing/browser@^0.2.0`** (`BrowserQRCodeReader.decodeFromConstraints`,
peer `@zxing/library@^0.22.0`), replacing the native `BarcodeDetector` so the scan works on every
browser (Firefox / older iOS). Bundled into the `/pair` IIFE only, alongside node-forge.

- **Why this lib:** the standard pure-JS multi-format barcode decoder; no native addon, runs in any
  browser. **Client-only, decode-only** — the decoded payload is `parsePairingPayload`-validated (zod,
  `pairingPayload.ts`) before use, and the *token* inside is what's gated server-side (single-use +
  short TTL, HS-8996), so a hostile QR can at worst feed a malformed/expired payload that's rejected.
- **Posture:** `npm audit` reports **no advisories against `@zxing/browser@0.2.0` / `@zxing/library@0.22.0`**
  (checked 2026-06-26). Not on the cert-signing path. Pinned to the matching peer pair (browser 0.2.0
  needs library ^0.22.0; the newer 0.23.0 was held back to satisfy the peer range).

## The cargo (src-tauri) baseline (HS-8649)

HS-8649 ran the first `cargo audit` over `src-tauri/Cargo.lock`. It reported **6
vulnerabilities + 21 informational warnings**. The same in-range-fix-first rule
the npm side uses cleared every `vulnerability`:

- **`rustls-webpki` 0.103.9 → 0.103.13** — clears four advisories: RUSTSEC-2026-0104
  (reachable panic in CRL parsing), RUSTSEC-2026-0098 / -0099 (name-constraint
  matching bugs), RUSTSEC-2026-0049 (CRL distribution-point matching). Transitive
  via Tauri's TLS stack. Patch-level bump within `0.103.x`.
- **`tar` 0.4.44 → 0.4.46** — clears RUSTSEC-2026-0067 (`unpack_in` symlink chmod,
  medium 5.1) and RUSTSEC-2026-0068 (PAX size-header handling, medium 5.1).
  Patch-level bump.

Both were applied with a plain `cargo update -p rustls-webpki -p tar` (semver-
compatible; no other crates moved). After the bumps **`cargo audit` exits 0** —
no vulnerabilities — so the job is **blocking**.

The **21 residual warnings are all `unmaintained` / `unsound` informational
advisories**, not vulnerabilities, and plain `cargo audit` does not fail on them:

- **gtk-rs GTK3 bindings — unmaintained** (`atk` / `atk-sys` / `gdk` / `gdk-sys`
  / `gdkwayland-sys` / `gdkx11` / `gdkx11-sys` / `gtk` / `gtk-sys` / `gtk3-macros`,
  RUSTSEC-2024-0411…0420; plus the `glib` 0.18.5 unsoundness RUSTSEC-2024-0429).
  These are **Linux-only** GUI deps pulled in transitively by the Tauri/`rfd`
  stack; they don't ship on macOS/Windows builds and the gtk-rs project's "no
  longer maintained" status is a whole-ecosystem notice with no patched version
  to move to (it's superseded by gtk4 bindings, a major-version migration owned
  upstream by Tauri, not by Hot Sheet).
- **`rand` unsound (RUSTSEC-2026-0097, three versions) + `fxhash` /
  `proc-macro-error` / `unic-*` unmaintained** — all transitive, no patched
  version offered, and the `rand` unsoundness is conditional on "a custom
  logger that calls `rand::rng()`" which Hot Sheet's Rust code does not do.

None are reachable-and-fixable today; they're tracked here per the reachability
rule and will clear as Tauri advances its own dependency tree. If a future
`cargo audit` reports a NEW `vulnerability` (not warning) advisory, the blocking
job goes red — upgrade to the fixed version, or document an unreachable
justification here before merging.

## Running the audits locally

```bash
npm audit --omit=dev --audit-level=high     # production npm tree
npm audit                                   # everything, incl. dev toolchain
cargo audit                                 # from src-tauri/ (needs cargo-audit)
```

## Attack-surface review at release (HS-8987)

Dependency auditing (above) covers *known-CVE* exposure in third-party code. It
does **not** cover Hot Sheet's *own* attack surface — the routes, WebSocket
endpoints, OTLP ingest, MCP tools, plugin/keychain handling, and the
`--bind`/`trustedOrigins` exposure model (HS-7940 / HS-8983 / the HS-8985
strong-auth design in `docs/94-strong-remote-auth.md`).

The **`security-review` Claude skill** (`.claude/skills/security-review/SKILL.md`)
is the standing mechanism for that, run before each release: it re-derives the
attack surface from the current code (not a static list), checks each surface
(authn/authz before execution, input/abuse pre-filtering, injection, path
traversal, SSRF, secret leakage, CSRF/CSWSH, transport), does **proactive
external research** each run (latest advisories/CVEs for the actual dependency
versions + current attack patterns — not just training knowledge), and writes a
dated, severity-ranked report to `docs/security/security-review-YYYY-MM-DD.md`,
filing a `security`-tagged ticket per actionable finding. Run it on demand or as
a release-checklist step.

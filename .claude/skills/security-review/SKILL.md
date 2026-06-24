---
name: security-review
description: Re-analyze Hot Sheet's attack surface for security issues at release time, with proactive research using the latest advisories. Use before each release (or on demand) to audit every externally-reachable surface and file remediation tickets.
allowed-tools: Read, Grep, Glob, Bash, WebSearch, WebFetch, Agent
---

Comprehensively re-analyze Hot Sheet's **attack surface** and produce a dated, severity-ranked
security report. This is the standing "revisit the security analysis on every release" mechanism
(HS-8987). Hot Sheet is a high-value target: it runs shell commands + terminals (RCE-equivalent
authority), holds plugin OAuth tokens + keychain secrets, and — with `--bind` / the §46 remote
epic — can be reachable off-box. Treat it accordingly.

**Two non-negotiables that make this skill worth running:**
1. **Enumerate the surface from the CODE, not this list.** The list below is a starting map; the
   real surface is whatever the current code exposes. Re-derive it every run — new routes, new WS
   endpoints, new MCP tools, new plugins appear between releases.
2. **Do PROACTIVE external research every run.** Do not rely only on training knowledge — fetch the
   latest advisories/CVEs for the actual dependency versions and recent attack-pattern writeups.

## Step 1 — Re-derive the attack surface from the code

Don't trust the map below; regenerate it. Useful sweeps (adjust as the code moves):

- **HTTP routes:** `Grep` for `.get(` / `.post(` / `.patch(` / `.put(` / `.delete(` / `.use(` and
  `app.route(` across `src/routes/**` and `src/server.ts`. List every path + method.
- **WebSocket endpoints:** `src/terminals/websocket.ts` (`/api/terminal/ws`), `src/routes/wsSync.ts`
  (`/ws/sync`) — and any new `httpServer.on('upgrade')` handlers.
- **OTLP ingest:** `src/routes/otel.ts` (`/v1/metrics|logs|traces`) — sits OUTSIDE the `/api/*` auth
  middleware by design (HS-8983 gates it when exposed).
- **MCP tool surface (§63):** `src/channel.tools.ts` — every `hotsheet_*` tool an AI agent can call.
- **Channel sidecar:** `src/routes/channel.ts` + the channel server (`src/channel*.ts`).
- **Plugin endpoints:** `src/routes/plugins.ts` — plugin settings can hold long-lived OAuth tokens;
  the image-proxy / plugin fetches are SSRF candidates.
- **Attachment serving:** `src/routes/attachments.ts` — path-traversal surface (`/attachments/file/*`).
- **Keychain + secrets (§20):** `src/keychain.ts`, `src/secret-keys.ts`, `~/.hotsheet/config.json`.
- **Exposure model:** `src/trusted-origin.ts`, `src/routes/apiAccess.ts`,
  `src/routes/apiAuthMiddleware.ts`, the `--bind` / `trustedOrigins` config (HS-7940 / HS-8983),
  and the strong-auth design (`docs/94-strong-remote-auth.md`, HS-8985).
- **Tauri commands:** `src-tauri/src/lib.rs` `#[tauri::command]` (e.g. `open_external_url`,
  `tts_speak`, `save_file`) — the native surface the webview can invoke.

Read `docs/ai/code-summary.md` (the "where do I look for X" index) and `docs/dependency-security.md`
to orient. Record the surface inventory as the report's first section, and **diff it against the
previous run's report** (look for prior `docs/security/security-review-*.md`) to flag what's new.

## Step 2 — Check each surface

For every surface, ask:

- **Authentication before execution** — is the request authenticated before any handler runs?
  Which auth tier (loopback-only / shared-secret / trusted-origin / mTLS once HS-8985 lands)? Any
  OPEN path on an exposed server? (GET-lockdown HS-7940, otel gate HS-8983 are the interim.)
- **Authorization** — once authenticated, is the action's scope checked? (Cross-project access via
  a foreign secret, project-management endpoints, etc.)
- **Input validation + abuse pre-filtering (HS-8986)** — body-size caps before buffering, rate
  limits on an exposed server, content-type enforcement, **bounded** zod schemas (grep for
  unbounded `z.string()` / `z.array(` an attacker could use to balloon memory/DB), per-request
  caps on the OTLP ingest.
- **Injection** — SQL is parameterized via PGLite `query($1,...)`; **verify** no string-built SQL
  (`Grep` for template literals inside `query(`). Command injection in shell/terminal command
  construction (`src/terminals/**`, `src/routes/shell.ts`, `src-tauri` command building).
- **Path traversal** — attachment serving + any `join(dataDir, userInput)`; confirm normalization
  + containment (there are existing api.test cases — verify they still hold).
- **SSRF** — the image-proxy + any server-side `fetch` of a user/plugin-supplied URL.
- **Secret leakage** — secrets in logs, error bodies, URLs (query params show in access logs),
  WebSocket connect URLs, the markdown exports, freeze.log/startup.log.
- **CSRF / CSWSH** — the same-origin/trusted-origin checks on mutations + WebSocket upgrades; a
  malicious page must not be able to forge an authenticated request or socket.
- **Transport** — what's plaintext vs TLS/tunnel? (Today: tunnel-dependent; HS-8985 adds TLS.)
- **Dependency + supply chain** — `npm audit` / `cargo audit` posture (see `docs/dependency-security.md`).

Spawn parallel `Agent` sub-audits per surface if the surface is large — one agent per route group /
WS endpoint / the MCP surface — and have each return structured findings.

## Step 3 — Proactive external research (REQUIRED every run)

Pull the current dependency versions first: `Read` `package.json` + `src-tauri/Cargo.toml` (and the
lockfiles for exact versions). Then research, with `WebSearch` / `WebFetch`:

- **Advisories/CVEs for the actual versions** of: Node, `hono`, `@hono/node-server`, `ws`,
  `@electric-sql/pglite`, `zod`, `@anthropic-ai/sdk`, the Tauri crates, and each bundled plugin's
  deps. (`npm audit --json` + `cargo audit` give a machine baseline; web research catches what the
  databases haven't ingested yet + framework-specific advisories.)
- **Framework-specific attack patterns** published since the last review (hono middleware bypasses,
  `ws` DoS/`handleUpgrade` issues, TLS/mTLS pitfalls relevant to HS-8985, PGLite/WASM concerns).
- **Current top-N web/API attack patterns** — OWASP API Security Top 10 + any recent high-signal
  writeups relevant to the surfaces above.

Cite each source (URL + date) in the report. **Adversarially verify** anything that would become a
finding — don't report a CVE that doesn't apply to how we use the dep.

## Step 4 — Output a dated report + file tickets

Write `docs/security/security-review-YYYY-MM-DD.md` (create `docs/security/` if absent):

- **Surface inventory** (Step 1) + a diff vs the previous report (new/removed surfaces).
- **Findings**, each: title, surface, severity (Critical/High/Medium/Low), description, the concrete
  attack, evidence (`file:line`), recommended remediation, and any cited advisory.
- **Dependency posture** — `npm audit` / `cargo audit` summary + researched advisories.
- **Sign-off** — what was checked, what's deferred, open questions.

Then **file a Hot Sheet ticket per actionable finding** (use the `hotsheet_create_ticket` MCP tool
or `/hs-bug`), tagged `security`, cross-referencing the report. Keep `docs/dependency-security.md`
in sync. Lead the report with a one-line **TL;DR** verdict (clean / N findings / M critical).

## Step 5 — Wire into the release flow

This skill should be run before each release. Confirm `release.sh` (or the release checklist in the
docs) references it; if not, note that as a finding so the standing mechanism actually fires. Do
NOT auto-edit `release.sh` without surfacing it — the maintainer owns the release pipeline.

## Notes

- This skill **reports + files tickets**; it does not fix. Remediation is separate tickets (e.g.
  HS-8985 strong auth, HS-8986 request hardening) so each fix gets its own review.
- Be adversarial and concrete — a finding is "here is the request an attacker sends and what they
  get", not "consider hardening X".
- American English throughout (project convention).

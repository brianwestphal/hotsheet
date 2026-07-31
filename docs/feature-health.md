# Feature Health

**Snapshot date: 2026-07-24.** Regenerate with **`/feature-health`**.

> **Gated since HS-9411 (docs/124):** parallel agent workers and remote access are **off by default**
> behind Settings → Experimental → **In Development**. Their status here is unchanged; they are
> simply no longer reachable by accident.
>
> **AI tools are opt-in since HS-9517 (2026-07-31).** The per-tool `dev_tool_*` gates were removed
> (HS-9515) and replaced with a plugin-style model: `maturity` decides what ships (**Claude** stable,
> **Codex** beta, the rest **unreleased** and hidden behind Settings → Experimental → "Unreleased AI
> tools"), and a per-project enable decides what a user has opted into. **Claude alone is enabled by
> default.** So the rows below are what a user sees only after choosing them — and the maturity
> marking is meant to track this doc's assessment, not run ahead of it.

This doc answers one question for every feature: **does it actually work?**

That is deliberately NOT the question [`ai/requirements-summary.md`](ai/requirements-summary.md)
answers. That doc tracks whether a feature was *built* (Shipped / Partial / Design only). This one
tracks whether it is *trustworthy* — verified, unverified, or actively broken. A feature can be
100% Shipped there and Unknown here (built, never realistically exercised), and that gap is the
entire point of this doc.

**Out of scope: enhancements.** Every feature could do more. Notes here only record **missing core
functionality, known bugs, unsettled decisions, or absent verification**. A feature with no notes is
a feature with nothing wrong that we know of.

## Status vocabulary

| Status | Meaning |
| --- | --- |
| **Solid** | Works. Dogfooded daily AND covered by automated tests. No known gaps. |
| **Solid\*** | Works, but part of it is only verifiable by hand and no verification is recorded. |
| **Shaking out** | Shipped within ~2 weeks and still accruing fix commits. Expect bugs. |
| **Underbaked** | Presented as working, but is buggy, incomplete, or resting on an unsettled decision. |
| **Incomplete** | Core functionality is missing. Not usable for its stated purpose. |
| **Unknown** | Built and plausibly fine, but never realistically exercised. No evidence either way. |
| **Not built** | Advertised or expected, but absent. |

## Dashboard

| | Count |
| --- | --- |
| Solid / Solid\* | 47 |
| Shaking out | 3 |
| Underbaked | 13 |
| Incomplete | 3 |
| Unknown | 12 |
| Not built | 1 |

**The shortlist — what to fix or verify first:**

1. **Project-switch state reset** — **audited (HS-9409, `docs/125`)**: now *eleven* bugs of one identical class, four of them found by the audit itself — including two that render **another project's data** (code-review notes HS-9413, per-ticket cost stats HS-9414). Guard designed in `docs/125` §125.5; fixes HS-9412–9415, structural guard HS-9416 + HS-9417.
2. **Worker pool** — the manager is session-only in memory; no test runs an actual worker.
3. **Non-Claude AI tools** — a very large surface where only Codex has had real use, and it is days old.
4. **Remote-access client** — foundation only; the server half has never had a real off-box deployment.
5. **Tauri desktop app** — the single largest untestable surface in the product.
6. **OSC 133 shell integration** — fully built, then abandoned mid-decision, with a wrong default that went unnoticed for a month.

---

## Core ticket management

| Feature | Status | Notes |
| --- | --- | --- |
| Ticket CRUD / statuses / priority / Up Next | Solid | |
| Batch / bulk operations | Solid | |
| Tags | Solid | |
| Ticket cross-references (`HS-NNNN` → modal) | Solid | |
| `blocked_reason` + row indicators | Solid | |
| Notes + FEEDBACK NEEDED flow | Solid | |
| Undo / redo | Underbaked | Rewritten twice recently (native-undo, per-project stacks, modal scoping). **HS-9363 is open: the semantics conflict between HS-9117 (app-undo) and HS-9335 (native-undo) is undecided**, so current behavior is a compromise nobody signed off on. |
| Search + filters, include archive/backlog rows | Solid | |
| Custom views + per-machine local customization | Solid | |
| Attachments (upload / paste / drop / reveal) | Solid\* | OS-clipboard paste and Finder reveal are manual-only (6 manual items). |
| Markdown sync (worklist / open-tickets) | Solid | |
| Auto-prioritize | Solid | |

## User interface

| Feature | Status | Notes |
| --- | --- | --- |
| List + column views | Solid | |
| Detail panel | Solid | |
| Reader mode + note navigation | Solid | |
| Sidebar + counts | Solid | |
| Project tabs + cross-project drag | Solid | |
| **Project switching (per-project state reset)** | Underbaked | The most bug-prone seam in the app. Seven bugs, one class: app title (HS-8451), ticket prefixes (HS-8053), detail refresh (HS-8062), git chip (HS-7993), tag cache (HS-8737/8738), `ai_tool` (HS-9406), the rest of `loadSettings` (HS-9407). **Nothing structurally prevents the next one** — any per-project cache added without an explicit reset is a latent bug. |
| Settings dialog + Shared/Local scope control | Underbaked | The scope machinery keeps shipping (§95.3, §107, §108, HS-9004/9014/9017) while **§95's classification model is still "Design, open decisions in §95.4"** — which settings are personal vs team vs machine was never settled. Both HS-9406 and HS-9407 live in that gap. |
| Dark mode | Not built | HS-8851 (backlog). Notable absence for a developer tool. |
| Keyboard shortcuts | Solid | Bindings work; the settings UI to view/rebind them does not exist (HS-7928). |
| Share prompt | Solid | |
| Upgrade nudge | Solid | |
| Git status chip | Solid | |

## Terminals

| Feature | Status | Notes |
| --- | --- | --- |
| Embedded terminal + drawer | Solid | Most-exercised subsystem in the app. |
| Terminal dashboard + tile grid | Solid\* | Tile sizing/rendering has regressed repeatedly — four dedicated specs exist because of it. |
| Terminal checkout / xterm stack | Solid | |
| Terminal search | Solid | |
| Themes + fonts | Solid | |
| Visibility + named groupings | Solid | |
| Title + bell, cross-project bell | Solid | |
| **OSC 133 shell integration** | Underbaked | Fully built (4 phases, 4 docs, e2e) then abandoned mid-decision. **HS-9195 open — "decide: promote to default-on, keep opt-in, or remove"**; HS-9174 the install docs were never written; HS-9175 no feedback when enabled but no markers arrive. The HS-9188 default-off flip **silently never took effect** until HS-9407 — its real state was wrong for a month. |
| OSC 7 (cwd chip) / OSC 8 (hyperlinks) | Solid | |
| OSC 9 toasts / native notifications | Solid\* | Native path is Tauri-only and manual-verify only; e2e explicitly deferred. |
| Quit confirmation | Solid\* | 17 manual items — the highest manual count in the plan. |
| Per-terminal shell history | Solid | |
| Multi-client terminals (active-device model) | Solid\* | Two-device e2e exists; real multi-device use untested. |

## AI drive

| Feature | Status | Notes |
| --- | --- | --- |
| Claude Channel (play / auto / busy / done) | Solid | The daily driver. |
| Permission overlay + allow rules | Solid | |
| MCP tool surface (`hotsheet_*`) | Solid | |
| Custom commands (Claude + shell, groups, long-press) | Solid | |
| "Run on…" worker target picker | Unknown | Its only real use is worker pools, which don't work end-to-end. 8 manual items, no e2e. |
| Commands log | Solid | |
| Skills + `CLAUDE.md` instruction generation | Solid | |
| Multi-tool instructions (Cursor / Windsurf / Copilot) | Solid\* | Generation is tested; nobody has confirmed the target tools actually consume the output. |
| **Codex drive (app-server)** | Shaking out | Shipped 2026-07-23 with six follow-up commits already (daemon transport, MCP elicitation fix, reattach chip, daemon pre-start). Days old. |
| **Antigravity drive** | Unknown | Shipped HS-9319→9328. 4 manual items, no automated end-to-end, no evidence of sustained real use. |
| **OpenCode / ACP** | Unknown | Same shape — 5 manual items, live-validated once during development, not since. |
| Gemini / Goose / Kiro | Incomplete | Gemini gets config generation only, no drive. Goose deferred (HS-9347). **Both are marked `unreleased` (HS-9517) and are not shipped** — absent from the AI Tools list unless the Experimental gate is on, so the picker no longer advertises more than exists. |
| Tool-switch config prep (§119) + adapter retirement (§120) | Shaking out | Both shipped in the last few days. HS-9378 (conflict-merge flow) is a known unbuilt branch. |
| Agent-backend transport picker | Underbaked | Capability table + `agent_backend` override shipped, but **§115.7's shared three-way picker is missing**, so transport selection is half-manual, half-inferred. |
| Announcer (§78–§82, all providers) | Solid | 15 unit-test files + e2e; confirmed functional in real use. |

## Workers / distributed execution

| Feature | Status | Notes |
| --- | --- | --- |
| **Worker pool manager** | Incomplete | `src/workers/poolManager.ts` states it plainly: *"pure in-memory + keyed by project data dir; session-only (no persistence)"*. **Restart the server and the pool registry is gone**, while the panel implies durable workers. |
| **Worker pool panel** | Unknown | `e2e/worker-pool.spec.ts` asserts only empty states, disabled controls, and button visibility. **No test runs an actual worker.** 12 manual items. |
| Git worktrees | Underbaked | Phases A–C shipped, Phase D gated on unfinished work. 5 manual items, no real e2e. |
| Claim/lease primitive + `blocked_by` gate | Solid | Genuinely unit-tested; it's the layers above that are thin. |
| Coordinator dispatch (drag → worker tile) | Unknown | 8 manual items, no e2e. |
| Owner-side integration helpers | Solid\* | Unit-tested; the multi-worker flow they exist for is not. |
| Prompt-based worker management | Unknown | 5 manual items, needs a live channel to verify. |

## Data & storage

| Feature | Status | Notes |
| --- | --- | --- |
| PGLite + schema / migrations | Solid | |
| Backup / restore | Solid | |
| Backup JSON co-save + attachment backups | Solid | |
| Snapshot protection + auto-restore | Solid | |
| **DB repair (`pg_resetwal`)** | Unknown | Only the UI is tested (`dbRepairUI.test.ts`). The actual repair path is a disaster-recovery tool that has never been exercised against a genuinely corrupt database. |
| Cleanup + retention sweeps | Solid | |
| Telemetry ingest + rollups | Solid | |
| **Telemetry dashboards (§70 cross-project, §71 per-project)** | Unknown | **No e2e coverage at all** — the `dashboard-*` specs are all *terminal* dashboard. Large read-only UIs with no automated verification. |

## Integrations & platform

| Feature | Status | Notes |
| --- | --- | --- |
| Plugin system | Solid\* | Six plugin e2e specs. **But the public `PluginUIElement` type declares `toggle`, `switch`, and `segmented_control`, which `src/client/pluginUI.tsx` never renders** (only `button` and `link`). An API advertising controls that silently do nothing; `plugin-development-guide.md` §"Location rendering" does disclose it. |
| GitHub plugin + sync engine | Solid\* | Nine sync specs, but they require credentials and are excluded from `test:fast`, so local runs skip them. |
| Scheduled auto-sync | Unknown | 5 manual items; time-based behavior is not automatically verified. |
| Secure storage / keychain | Solid\* | Unit-tested; 9 manual items, and the non-macOS backends (libsecret / Windows) are essentially unverified. |
| **Tauri desktop app** | Unknown | Playwright is Chromium, so **none of the desktop app is e2e-testable**. 10+ manual items span the updater, sidecar, CLI installer, and native dialogs. The Tauri-unsafe-API rule in `CLAUDE.md` exists precisely because tests pass while the desktop build is broken. |
| CLI / server launch modes | Solid | |
| Demo mode | Unknown | Two unit-test files, 5 manual items, no e2e. It is the first thing a new user sees. |
| Isolated test instance (`--test`) | Underbaked | Works, but **keychain namespacing is deferred (HS-8923)** — the test instance shares the real keychain and can read or overwrite live secrets. |
| **Remote access — server (mTLS)** | Unknown | Enforcement logic is genuinely tested (unit + `npm run validate:mtls` against the real listener), but **there have been zero real off-box deployments**. §94.11's own sign-off says the real `--bind` test "should run at the next release"; it has not. |
| **Remote access — client** | Incomplete | Foundation only (origin-aware URL builders, `remotes.json`, tab merge). No add-server UI (HS-9303), no project enumeration (HS-9304), no connectivity state (HS-9305), and the Tauri path cannot present a client certificate at all (HS-9314). Adding a remote today means hand-editing `~/.hotsheet/remotes.json`. |
| WebSocket push sync (`/ws/sync`) | Solid | |
| Code Review section (§122) | Shaking out | Shipped 2026-07-23 and immediately took four fix commits (chooser toggle, stale content on ticket switch, row wrapping). |
| `.pr-notes` proof-artifact surfacing (§111) | Solid | |
| AI review-notes inducement (§110) | Underbaked | P1/P2 shipped, P3 pending, **and the gating model in §110.4 is still an open decision** — the feature's activation rules aren't settled. |

## Cross-cutting

| Item | Status | Notes |
| --- | --- | --- |
| **Status-doc accuracy** | Underbaked | `ai/requirements-summary.md` has drifted in both directions: §93 (WebSocket push) is marked *"Partial — endpoint/emission/client pending"* while the code and `CLAUDE.md` say shipped; §85 (telemetry retention) is marked *design* while `src/cleanup.ts` implements it. The doc you'd consult to answer "what's incomplete?" is itself unreliable. |
| **No record of manual verification** | Underbaked | `manual-test-plan.md` holds ~600 items with **zero ever checked**. For every Unknown above — Tauri, exposed bind, real agents, demo mode — there is no way to distinguish "verified once" from "never run". |
| Test-suite reliability | Underbaked | CI runs with `retries: 3` against a documented residual flaky tail (HS-9362 open). Flakes erode the signal everything else here depends on. |
| Vitest exit hang | Underbaked | HS-9391 open — the full suite intermittently never exits (all tests pass, no summary printed). |

---

## How this assessment is made

The status of a feature is derived from evidence, not impression. In rough order of weight:

1. **Automated coverage** — an e2e spec in `e2e/` that drives the real user flow, plus unit tests.
   A spec that only asserts empty states or button visibility does **not** count as covering the
   feature (see the worker-pool row).
2. **Dogfooding** — is this exercised constantly by the maintainer while running Hot Sheet on
   Hot Sheet? Ticket management, terminals, the channel, and commands get this for free; a
   telemetry dashboard or the `--test` flag does not.
3. **Recent churn** — a burst of fix commits right after a feature ships means it is still shaking
   out. `git log --oneline -200` is the fastest read on where the bugs currently are.
4. **Open bug/issue tickets** and **unsettled decisions** — an open "decide whether to keep this"
   ticket makes a feature Underbaked no matter how complete the code is.
5. **Manual-only surfaces** — anything that can only be verified by hand (Tauri, keychain, real
   agents, exposed bind, OS clipboard) is at best Solid\*, and Unknown if nothing suggests it has
   actually been run.

Two traps worth restating, because both have already produced wrong conclusions here:

- **"Shipped" ≠ "works."** `requirements-summary.md` tracks intent-to-completion, and it has drifted.
  Always confirm against code and tests.
- **Docs can advertise more than the code does.** The plugin control types and the `ai_tool` dropdown
  both list capabilities that silently do nothing. Type unions and dropdown option lists are worth
  diffing against their renderers/handlers.

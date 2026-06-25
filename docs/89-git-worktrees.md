# 89. Git Worktrees + Per-Worktree AI Agents

**Status: PARTIAL** (HS-8905 design, 2026-06-22). **Phase A shipped (HS-8934)** —
the follower pointer + project-data redirect. **Phase B shipped** — server core
(HS-8935: create/list/remove + API) + UI (HS-8938: management panel from the git
popover). **Phase C shipped (HS-8936)** — per-worktree AI terminal + agent wiring
(owner-direct `.mcp.json` + owner-worklist skills). **Phase D designed (HS-8937,
2026-06-23)** — the claim model is resolved in
[90-distributed-execution.md](90-distributed-execution.md) (§90) and the Phase D
shape (durable worker pool, dynamic scaling, both coordination modes,
single-machine first) is pinned in §89.2; implementation is the gated chain
(HS-8862/8863/8864/8865 + HS-8960/8961). Scope decision (HS-8905 feedback):
**standalone doc, follower `.hotsheet/settings.json` pointer model.**

## 89.0 Goal

Let a maintainer run several **git worktrees** of one repo side by side, each
with its **own AI terminal** (Claude / ACP agent), where every worktree's agent
talks to the **same Hot Sheet instance / ticket DB** — so the maintainer watches
all the parallel work land live in one UI. The end state automatically
parallelizes tickets across worktrees; v1 is the manual substrate that makes it
possible.

This is the **"isolated checkout" substrate** the distributed-execution epic
already calls for: HS-8863's worker loop is "claim-next → work the ticket in its
own isolated checkout/worktree → complete → release". Worktrees are how that
isolation is realized on a single machine; claim/lease (HS-8862) is how the
agents avoid double-claiming.

## 89.1 The shared-instance mechanism: follower `.hotsheet/settings.json`

A linked git worktree has its own working directory, so a Hot Sheet / Claude
terminal launched there would by default create and target its **own**
`.hotsheet/`. The chosen model (HS-8905 feedback) avoids that:

> A worktree gets a lightweight `.hotsheet/settings.json` that simply **points to
> a parent / owner / authoritative `.hotsheet` folder.**

### Contract

- A **follower** `.hotsheet/settings.json` carries a pointer field, e.g.
  `authoritativeDataDir: "<abs path to the owner repo's .hotsheet>"` (exact key
  TBD — see open questions). When present, this directory is a *follower*: it
  owns no PGLite DB, no project registration of its own.
- Everything that resolves a project data-dir from a worktree —
  the CLI/server (`getDataDir` / `setDataDir`), the channel server, MCP/skill
  generation (`src/channel-config.ts`, `src/skills.ts`), markdown sync, git chip
  — **redirects to the authoritative dir**. Net effect: a Claude terminal opened
  in a worktree drives the **one** shared ticket DB + the one running instance
  (reusing the existing single-instance-per-dataDir + channel multi-connection
  model, §HS-8460).
- **Resolution is one hop, validated:** the authoritative dir must be a real
  `.hotsheet` that is itself NOT a follower (reject chains/cycles; reject a
  missing/again-follower target with a clear error rather than silently creating
  a fresh DB).
- The pointer file is local + gitignored (the `.hotsheet/` ignore already covers
  it); it is per-checkout, never committed.

### Why this shape

- Reuses the authoritative project's secret / channel / instance — no second
  server, no data federation, no sync. "Same Hot Sheet instance" falls out for
  free.
- Composes with HS-8920's `globalHotsheetDir()` work (global vs. project state
  are already separated) — this is the **project-data** analogue: a per-worktree
  redirect of the *project* data-dir.

### What still needs writing per worktree

For a worktree's AI terminal to actually reach the shared instance, Hot Sheet
must, when creating/registering a worktree, write into the worktree:
- a `.mcp.json` registering the **authoritative** project's channel (so the
  agent's `hotsheet_*` MCP tools hit the shared instance — `src/channel-config.ts`),
- the `.claude/skills/**` (so `/hotsheet` etc. work there — `src/skills.ts`),
- the follower `.hotsheet/settings.json` pointer itself.

These already exist as per-project-root writers; the work is to target a
worktree root + point them at the authoritative project.

## 89.2 Components (phased)

### Phase A — Follower pointer + redirect resolution ✅ SHIPPED (HS-8934)
The `.hotsheet/settings.json` `authoritativeDataDir` pointer + the resolver that
redirects project-data lookups to the owner. **The keystone.**

Implemented as `resolveAuthoritativeDataDir(dataDir)` in `src/file-settings.ts`:
reads the follower's settings.json, and when `authoritativeDataDir` is set,
returns the (absolute) owner dir after validating **one hop** — rejects a
self-reference, a missing target, or a target that is itself a follower (chains),
throwing rather than silently creating a second DB. Applied at the two data-dir
entry chokepoints so everything downstream uses the owner: `src/cli.ts::main`
(primary launch — a bad pointer is a fatal startup error) and
`src/projects.ts::registerProject`/`registerExistingProject` (Open Folder /
multi-project; the dedup-by-dataDir then maps the follower onto the owner's
existing context). The `authoritativeDataDir` key is a reserved setting (not a
project setting). Tests: `file-settings.test.ts` (resolver unit cases) +
`worktreeFollower.e2e.test.ts` (spawns against a follower dir → owner DB gets the
data, no follower DB; bad pointer fails fast).

### Phase B — Worktree management (create / list / remove)
**Server core ✅ SHIPPED (HS-8935).** `src/worktrees.ts` —
`listWorktrees(repoRoot)` (parses `git worktree list --porcelain`, annotates each
entry with its follower pointer, main first), `createWorktree(repoRoot,
ownerDataDir, {branch, path?, newBranch?, baseRef?})` (`git worktree add` →
default sibling `../<repo>-worktrees/<branch>`, then writes the follower
`.hotsheet/settings.json` pointing at the owner + defensively ensures it's
gitignored), `removeWorktree(repoRoot, path, {force?, deleteBranch?})`. Git is
shelled async with an injectable runner; path matching is symlink-robust
(`realpathSync` — macOS `/var`→`/private/var`). API: `GET /api/worktrees`,
`POST /api/worktrees`, `POST /api/worktrees/remove` (`src/routes/worktrees.ts`,
typed in `src/api/worktrees.ts`). Tests: `worktrees.test.ts` (parse + real-git
create/list/remove/deleteBranch) + `api/worktrees.test.ts`.

**UI ✅ SHIPPED (HS-8938).** `src/client/worktreesPanel.tsx` — an overlay that
lists worktrees (main + follower badges + path), creates one (branch input +
"New branch" checkbox → `createWorktree`), and removes one (`confirmDialog`
danger → `removeWorktree({force})`). Opened from an iconic "Manage worktrees"
button (lucide `git-branch`) in the sidebar git popover's **header line**, just
before the close button (`gitStatusPopover.tsx`; moved there from the popover
body in HS-9068). Tests:
`client/worktreesPanel.test.ts` (row render, list/empty/error states, create +
remove flows, Escape-to-close).

**Re-slice:** the `.mcp.json` + skills writes (and making the owner's worklist
reachable from the follower) moved to **Phase C** — they're the agent-wiring the
per-worktree terminal consumes, and the follower-has-no-worklist problem needs
solving where it's exercised.

### Phase C — Per-worktree AI terminal (+ agent wiring) ✅ SHIPPED (HS-8936)
"Open a Claude terminal in this worktree" — the worktrees panel (HS-8938) gains
an **Open terminal** button per worktree that calls
`openTerminalRunningCommand('claude', …, worktree.path)` (`POST /terminal/create`
with `cwd` + `runCommand` + `spawn`), so a Claude terminal runs in the worktree's
directory and picks up its `.mcp.json` → the shared owner Hot Sheet.

**Agent wiring (written at worktree-create time, `worktrees.ts::createWorktree`):**
- **`.mcp.json` → owner-direct** (HS-8905 decision 2): `registerChannelAt(
  worktreeRoot, ownerDataDir)` (new in `channel-config.ts`, extracted from
  `registerChannel`) writes the channel entry at the worktree root with the
  **owner's** `--data-dir` + server key, so the worktree's `hotsheet_*` MCP tools
  drive the one shared instance — no dependence on channel-side follower
  resolution.
- **Skills → owner worklist** (HS-8905 decision 1a): `ensureSkillsForDir(
  worktreeRoot, undefined, ownerDataDir)` — `skills.ts` now threads an optional
  `dataDir` override through `ensureClaudeSkills`/`mainSkillBody`/`ticketSkillBody`
  so the worktree's `/hotsheet` skill + curl forms reference the **owner's**
  worklist path (relative to the worktree → `../<repo>/.hotsheet/worklist.md`) and
  port/secret. The follower has no worklist of its own.
- Both are best-effort (a wiring hiccup never fails worktree creation).

Choice of AI tool is currently `claude`; the existing terminal-target config can
extend this later.

**Worker channel connections are tagged (HS-9038).** Each worker spawns its own
channel server (registered under the owner data dir), so with N workers running
there are legitimately N+1 alive channel servers — which used to trip the "N Claude
connections active" multi-connection warning (HS-8460) as if they were duplicate
main agents. Fix: the channel server records a `worktree` marker in its registry
entry (`channelRegistry` `ChannelInfo.worktree`) when its cwd carries the
`authoritativeDataDir` follower pointer (detected via a light `readFileSettings`
check in `channel.ts::isFollowerCwd`, not the heavier `worktrees.ts` import). Then:
(1) the status route counts only **main** (non-worktree) connections for the
warning, so workers don't trigger it; (2) `pickLeader` prefers the oldest **main**
connection, so the play button / triggers always route to the main agent, never a
worker; (3) `cleanupExtraConnections` ("Clean up" button) kills only duplicate
mains and never a worker. This is the per-worker analog of the single-instance
multi-connection handling referenced in §89's Phase A constraints.

### Phase D — Auto-parallelization across worktrees
The end-state vision: N worktrees + agents that each claim-next → work in their
worktree → complete → release, draining the Up Next pool in parallel. **This is
HS-8863's worker loop with worktrees as the isolation;** the claim/lease primitive
+ coordination model it consumes are designed in
[90-distributed-execution.md](90-distributed-execution.md) (§90 — HS-8861 resolved
there). Gated on the prerequisites below, not built here.

Phase-D-specific decisions (HS-8937 feedback, 2026-06-23 — details in §90.5/§90.7):
- **Durable per-worker pool**, not per-claimed-ticket worktrees — N long-lived
  worktrees, each an agent terminal looping claim→work→complete→release. Resolves
  the §89.5 lifecycle-coupling question in favor of durable slots (per-ticket
  ephemeral worktrees are rejected for git/disk churn).
- **Dynamic scaling up/down:** the owner adds/drains workers at any time; a
  scaled-down worker stops *after* its current ticket releases, then its worktree
  is removed. N is not fixed at launch.
- **AI-assisted sizing:** the owner can ask the AI to recommend a reasonable N for
  the upcoming Up Next batch (independent-vs-coupled + `blocked_by` analysis); the
  owner sets the actual N.
- **Both coordination modes** (§90.5): autonomous self-claim (idle worker pulls
  `claim-next`) AND owner dispatch (assign related chunks to a specific worktree).
- **Single-machine first** — N worktrees against the local server; off-box workers
  are a later extension gated on the §46 remote epic.

## 89.3 Prerequisites (existing tickets — the "ticket checkout" + remote epics)

Phases A–C are largely self-contained (single machine). Phase D (parallel
agents) depends on:

- **HS-8862 — claim/lease primitive** ("ticket checkout": atomic
  `claim-next`/`claim`/`renew`/`release` + `claimed_by`/lease schema + MCP tools).
  This is *the* prerequisite the HS-8905 note calls "ticket claiming support".
- **HS-8863 — distributed worker loop** ✅ **shipped** (claim → isolated checkout →
  complete → release → repeat): the `hotsheet-worker` Claude skill + the
  `src/workers/workerLoop.ts` reference loop + the `prepareWorker` launcher
  (`POST /api/workers/launch`) that opens a worker terminal in a follower worktree.
  Worktrees are its isolation mechanism; the durable pool over it is HS-8962.
- **HS-8861 — distributed-execution design spike** (finalizes the claim model /
  lease semantics / selection policy this builds on).
- **HS-8864 — claimed-by / in-flight-worker UI** (so the maintainer sees which
  worktree/agent holds which ticket).
- **HS-8865 — planning/dependency gate** (FLAT `blocked_by` so parallel agents
  don't grab dependents early).
- **§46 service/client decoupling** — only needed if worktree agents run
  off-box; pure single-machine multi-worktree does not require it:
  - **HS-7940** — opt-in non-localhost bind + auth.
  - **HS-7944** — service-only mode.
  - **HS-7945** — WebSocket push bus (live claim/release across observers).

A single-machine, single-maintainer worktree setup (Phases A–C + a simple
local worker loop) can work against the existing local server without the §46
remote stack; §46 is the prerequisite for *remote* parallel workers.

## 89.4 Decisions made

- **Design-only now** (no code this pass) — HS-8905 feedback (1a).
- **Standalone doc** (this file), cross-linked to the distributed-execution epic
  — HS-8905 feedback (2).
- **Follower `.hotsheet/settings.json` pointer** to an authoritative `.hotsheet`,
  not per-worktree projects that federate — HS-8905 feedback (3).
- **Flat, not hierarchical** — parallel work is gated by the epic's flat
  `blocked_by` (HS-8865), never re-introducing sub-tasks (reverted 2026-03-23).
- **Pointer key = `authoritativeDataDir` (absolute path)** — HS-8934.
- **Follower-worklist = decision 1a** (the worktree's skills reference the
  OWNER's worklist) and **`.mcp.json` = owner-direct (decision 2)** — HS-8905
  feedback, implemented in HS-8936.

## 89.5 Open questions (remaining)

- Worktree default location + branch-naming convention; whether removal also
  deletes the branch (the API supports `deleteBranch`; the UI keeps the branch
  for now).
- ~~Lifecycle coupling: is a worktree created per *claimed ticket* or as a durable
  user-managed checkout, or both?~~ **Resolved (HS-8937):** durable per-worker pool
  slots (§89.2 Phase D / [§90.7](90-distributed-execution.md)), not
  per-claimed-ticket worktrees.
- Multi-project: a follower points at one authoritative project; confirm a
  worktree never needs to span projects.

## 89.6 Follow-up tickets

- **HS-8934 — Phase A:** follower `.hotsheet/settings.json` pointer + project-data
  redirect resolution. **✅ Shipped.**
- **HS-8935 — Phase B (server core):** create / list / remove git worktrees +
  follower-pointer write + API. **✅ Shipped.**
- **HS-8938 — Phase B (UI):** worktree management panel (list/create/remove).
  **✅ Shipped.**
- **HS-8936 — Phase C:** open an AI terminal per worktree + the agent wiring
  (owner-direct `.mcp.json` + owner-worklist skills). **✅ Shipped.**
- **HS-8937 — Phase D (design):** ✅ design done — claim model resolved in
  [90-distributed-execution.md](90-distributed-execution.md) (§90), Phase D shape
  pinned above. Implementation is the gated chain below.
- **HS-8861 — distributed-execution design spike:** ✅ resolved → §90.
- **HS-8862/8863/8865 — claim primitive / worker loop / flat `blocked_by` gate:**
  ✅ shipped 2026-06-23 (§90.10 items 1-3). **HS-8864 — claimed-by UI:** backlog.
- **HS-8962 — worker-pool manager + panel (Phase D wiring):** ✅ shipped 2026-06-23
  (in-memory pool manager + drain-aware claim-next + worker-pool panel; §90.10 item 6).
  The numeric target-N stepper (HS-8971) + AI-suggested N (HS-8963/HS-8960, §91.6) remain backlog.
- **HS-8961 — coordinator-dispatch UX (owner partitions chunks):** backlog
  (§90.5.2).
- **§46 epic (HS-7940/7944/7945/7946):** off-box remote workers only; not needed
  for single-machine Phase D.

## 89.7 Branch integration workflow (HS-9044) — ✅ encoded in the skills

Until HS-9044, a worker's branch was just **kept** on drain and never merged —
work accumulated on `hotsheet/*` branches with no path back to the target. HS-9044
encodes an **owner-as-integrator** workflow into the `/hotsheet` + `/hotsheet-worker`
skills (`src/skills.ts`, `SKILL_VERSION` → 14):

- **Why the owner integrates (not the workers):** in the worktree model the target
  branch (usually `main`) is checked out in the **owner's** worktree, so git won't
  let a worker — in its own worktree on its own branch — write/merge into the
  target. The decision (2026-06-25, maintainer): the main `/hotsheet` agent is the
  **single writer/integrator** to the target; workers prepare their branches but
  never write the target. (Alternatives considered: workers self-integrate via a
  fast-forward + lock when the owner's worktree is clean; or per-worker clones with
  a shared remote. The single-writer model is the safe fit for the shared-worktree
  setup and avoids races on the target.)
- **Workers** (`/hotsheet-worker`): after doing the work they **commit** it on their
  branch (scoped, never `git push` without permission), then **rebase onto the
  latest target** to stay current — resolving trivial conflicts, aborting + leaving
  a `FEEDBACK NEEDED:` note for non-trivial ones. They **hand off** (leave commits
  on the branch); they do not merge the target.
- **Owner** (`/hotsheet`): keeps the target current (`git fetch` + `pull --rebase`),
  then **integrates ready worker branches** (`hotsheet/*` ahead of the target) in
  ticket-priority order, running the gates after each merge, auto-resolving trivial
  conflicts and **asking** on the hard ones. Local integration only — no push
  without explicit permission.
- **Staying up to date** applies to everyone: both skills rebase/pull onto the
  latest target before working so changes on the target propagate to every worktree.

**"Merge pending" indicator (HS-9045).** A `pending_integration` boolean column on
`tickets` (migration in `connection.ts`; in `TicketSchema`; settable via
`PATCH /api/tickets/:id` + the `hotsheet_update_ticket` MCP tool, `CHANNEL_VERSION`
→ 14) tracks the gap between "a worker completed a ticket on its branch" and "the
owner integrated it." The worker sets `pending_integration: true` when it completes
a ticket whose code it committed; the owner clears it (`false`) when it merges the
branch. A completed ticket carrying the flag renders a **"merge pending"** badge
(amber, in the claimed slot) + a `.pending-merge` row accent (`ticketRow.tsx` +
`styles.scss`), so the maintainer can see at a glance which completed work is done
but not yet on the target. Default false ⇒ existing + owner-direct-completed tickets
are never flagged. (Until the HS-9048 tooling lands, the agents set/clear the flag
by following the skill prose.)

**Programmatic integration helpers (HS-9048).** The mechanical, deterministic git
core is now a real module + endpoints (so the owner agent doesn't re-derive it from
prose), in `src/workers/integrate.ts`:

- `detectTargetBranch(repoRoot)` — robustly resolves the target: the remote default
  (`origin/HEAD`) → local `main`/`master` → the current branch.
- `listReadyBranches(repoRoot, target)` — the `hotsheet/*` branches **ahead** of the
  target (with ahead/behind counts) = the integratable work.
- `integrateBranch(repoRoot, branch, target)` — one **safe merge**: guards that the
  owner worktree is **clean** (`dirty-tree`) and **on the target** (`not-on-target`),
  then `git merge --no-ff`; on conflict it captures the conflicted files + **aborts**
  cleanly (`conflict`) for the agent to resolve/ask; **never pushes**.

Exposed as `GET /api/workers/integratable` (`{ target, branches }`) +
`POST /api/workers/integrate` (`{ branch }` → the structured result); typed callers
`getIntegratableBranches` / `integrateWorkerBranch` in `src/api/workers.ts`. The
`/hotsheet` skill (`SKILL_VERSION` → 17) uses these instead of hand-rolling git.
**Judgment stays with the agent** — it runs the gates after a `merged`, and resolves
or asks on a `conflict`; the helper deliberately does NOT auto-resolve conflicts or
run gates. Tests: `workers/integrate.test.ts` (real-git) + `routes/workers.test.ts`.

Still open (smaller follow-up): an **explicit "branch ready" signal** (a per-worker
flag/note when a worker has committed + rebased) so the owner integrates
deterministically rather than enumerating `listReadyBranches`; and having the
integrate helper optionally run the gates itself.

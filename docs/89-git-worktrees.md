# 89. Git Worktrees + Per-Worktree AI Agents

**Status: PARTIAL** (HS-8905 design, 2026-06-22). **Phase A shipped (HS-8934)** —
the follower pointer + project-data redirect. **Phase B server core shipped
(HS-8935)** — create/list/remove worktrees + follower-pointer write + API. Phase
B UI + Phases C–D pending; the parallel/claiming half (Phase D) is gated on the
distributed-execution epic (HS-8861–8865) and the §46 service/client decoupling
epic (HS-7940 / HS-7944 / HS-7945). Scope decision (HS-8905 feedback):
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

**Re-slice:** the `.mcp.json` + skills writes (and making the owner's worklist
reachable from the follower) moved to **Phase C** — they're the agent-wiring the
per-worktree terminal consumes, and the follower-has-no-worklist problem needs
solving where it's exercised. **UI** is a separate follow-up (a worktree
management panel).

### Phase C — Per-worktree AI terminal (+ agent wiring)
"Open a Claude (or configured AI tool) terminal in this worktree" — reuses the
existing terminal system (`src/terminals/**`, the §HS-8491 Claude-terminal
seeding) with the worktree as cwd. **Includes the agent wiring moved from Phase
B:** write the worktree's `.mcp.json` (channel → owner) + `.claude/skills/**`,
and make the owner's worklist reachable from the follower (the follower has no
worklist of its own — decide: skills reference the owner's worklist, or the
owner's markdown sync mirrors/symlinks it into each follower). Choice of AI tool
is the existing terminal-target config.

### Phase D — Auto-parallelization across worktrees
The end-state vision: a coordinator spins up N worktrees + agents that each
claim-next → work in their worktree → complete → release, draining the Up Next
pool in parallel. **This is HS-8863's worker loop with worktrees as the
isolation;** it is gated on the prerequisites below, not built here.

## 89.3 Prerequisites (existing tickets — the "ticket checkout" + remote epics)

Phases A–C are largely self-contained (single machine). Phase D (parallel
agents) depends on:

- **HS-8862 — claim/lease primitive** ("ticket checkout": atomic
  `claim-next`/`claim`/`renew`/`release` + `claimed_by`/lease schema + MCP tools).
  This is *the* prerequisite the HS-8905 note calls "ticket claiming support".
- **HS-8863 — distributed worker loop** (claim → isolated checkout → complete →
  repeat). Worktrees are its isolation mechanism; co-designed with Phase D.
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

## 89.5 Open questions (resolve when Phase A is picked up)

- Exact pointer key name + shape (`authoritativeDataDir` abs path vs. a relative
  `../..` ref vs. the owner project's secret). Abs path is simplest + robust to
  moves within one machine.
- Does a follower run its own (proxying) server process at all, or do its agent's
  MCP/channel simply target the authoritative running instance's port (read from
  the authoritative dir's `instance.json` / `channel-port`)? Lean: no second
  server — point MCP/channel at the authoritative instance.
- Worktree default location + branch-naming convention; whether removal also
  deletes the branch.
- Lifecycle coupling: is a worktree created per *claimed ticket* (auto, Phase D)
  or as a durable user-managed checkout (Phase B), or both?
- Multi-project: a follower points at one authoritative project; confirm a
  worktree never needs to span projects.

## 89.6 Follow-up tickets

- **HS-8934 — Phase A:** follower `.hotsheet/settings.json` pointer + project-data
  redirect resolution. **✅ Shipped.**
- **HS-8935 — Phase B (server core):** create / list / remove git worktrees +
  follower-pointer write + API. **✅ Shipped.**
- **HS-8938 — Phase B (UI):** worktree management panel (list/create/remove).
  Backlog. Depends on HS-8935.
- **HS-8936 — Phase C:** open an AI terminal per worktree + the agent wiring
  (`.mcp.json` + skills + owner-worklist reachability, moved from Phase B).
  Backlog. Depends on HS-8934 + HS-8935.
- **HS-8937 — Phase D:** auto-parallelize tickets across worktrees. Backlog;
  gated on the claim/lease epic (HS-8862/8863/8861/8864/8865) + §46
  (HS-7940/7944/7945 for remote workers).

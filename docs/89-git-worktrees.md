# 89. Git Worktrees + Per-Worktree AI Agents

**Status: DESIGN ONLY** (HS-8905, 2026-06-22). No implementation yet — this doc
+ its follow-up tickets are the deliverable. The parallel/claiming half is gated
on the distributed-execution epic (HS-8861–8865) and the §46 service/client
decoupling epic (HS-7940 / HS-7944 / HS-7945). Scope decision (HS-8905
feedback): **design-only, standalone doc, follower `.hotsheet/settings.json`
pointer model.**

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

### Phase A — Follower pointer + redirect resolution
The `.hotsheet/settings.json` authoritative-dir pointer + the resolver that
redirects project-data lookups to the owner. Buildable + testable single-machine,
independent of the remote/claiming epics. **This is the keystone.**

### Phase B — Worktree management (create / list / remove)
Hot Sheet UI + API to create a git worktree for the project (sensible default
location, e.g. a sibling `../<repo>-worktrees/<branch>`; branch new or existing),
list active worktrees, and remove one (with the usual `git worktree remove`
safety + cleanup of its follower `.hotsheet/` + `.mcp.json`/skills). Writes the
follower pointer + MCP + skills (§89.1) on create.

### Phase C — Per-worktree AI terminal
"Open a Claude terminal in this worktree" — reuses the existing terminal system
(`src/terminals/**`, the §HS-8491 Claude-terminal seeding) but spawns the PTY
with the worktree as cwd, the agent wired (via the follower pointer + MCP) to the
authoritative Hot Sheet. Choice of AI tool is the existing terminal-target
config.

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

Filed alongside this doc (all backlog):
- **HS-8934 — Phase A:** follower `.hotsheet/settings.json` pointer + project-data
  redirect resolution (keystone; single-machine).
- **HS-8935 — Phase B:** create / list / remove git worktrees from Hot Sheet
  (writes the follower pointer + `.mcp.json` + skills). Depends on HS-8934.
- **HS-8936 — Phase C:** open an AI terminal per worktree wired to the
  authoritative Hot Sheet. Depends on HS-8934 + HS-8935.
- **HS-8937 — Phase D:** auto-parallelize tickets across worktrees. Gated on the
  claim/lease epic (HS-8862/8863/8861/8864/8865) + §46 (HS-7940/7944/7945 for
  remote workers).

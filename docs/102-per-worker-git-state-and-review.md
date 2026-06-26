# 102. Per-Worker Git State + Review Across Worktrees

**Status: SHIPPED (core)** — Part 2, the per-worktree git chip (§102.3-102.4),
**SHIPPED** (HS-9081); Part 1, the Glassbox **diff-vs-target** review selector
(§102.2), **SHIPPED** (HS-9082). Both 2026-06-26. Design HS-9060. Remaining
follow-ups: the **review-in-worktree** mode (HS-9106) and the **merge-pending
badge** Review affordance (HS-9107). From the HS-9040 design investigation.

**What shipped (HS-9081):** `summarizeWorktreesGit(repoRoot, worktrees, git?, target?)`
in `src/workers/integrate.ts` batches ahead/behind (reusing `listReadyBranches`) +
one `git status --porcelain` per worktree (parallel, failure-open); the result is
folded into `GET /api/workers/pool` as an optional `git: {ahead, behind, dirty}`
per worker (`WorkerSlotViewSchema`), and `workerPoolPanel.tsx` renders a compact
`↑/↓/•dirty` chip per tile. The sidebar git chip (§48) stays main-worktree-focused.

**What shipped (HS-9082):** the pool poll also surfaces the integration `target`
branch (`PoolState.target`, computed once server-side), and each worker tile gets
a **"Review"** button (shown when it has committed work — `git.ahead > 0` — on a
known branch + the Glassbox CLI is installed, probed on panel open) that opens
Glassbox on the **`target..hotsheet/worker-N` range** via the existing
`reviewInGlassbox({mode:'range'})` endpoint — "what integrating this branch adds."
The in-place review-in-worktree variant + the merge-pending-badge pre-targeting are
the follow-ups above. Today the Glassbox "view changes" button and the sidebar
git-status chip/diff (§48) operate on the **main/owner worktree only**. With
workers in separate worktrees (each its own branch + dirty/ahead/behind), the
owner can't see or review worker changes from those surfaces. This adds
**per-worker visibility where the workers already live** — the natural review
surface for the HS-9045 "merge pending" + HS-9048 owner-integration flow. Builds
on [89-git-worktrees.md](89-git-worktrees.md) §89.7,
[91-worker-pool-scaling.md](91-worker-pool-scaling.md).

## 102.0 Principle (from HS-9040)

**Main is the default for all owner surfaces; per-worker git/review is opt-in and
lives in the worker-pool / worktree UI + an explicit Glassbox target — not forced
into the single-project chip.** The sidebar git chip stays main-worktree-focused
so the single-user / no-workers experience is unchanged and uncluttered.

## 102.1 The gap

- **Glassbox "view changes"** — `getGlassboxStatus` / `launchGlassbox` run against
  the **active project's** main worktree. No way to point it at a worker's branch.
- **Sidebar git chip/diff (§48)** — `GET /api/git/status` resolves
  `projectRootFromDataDir(dataDir)` = the **owner** repo root. It shows the owner's
  branch + dirty count + ahead/behind, never a worker's.

So when worker-1 finishes a ticket on `hotsheet/worker-1` in its own worktree, the
owner has no in-app way to **review that work before integrating it** (HS-9048).

## 102.2 Part 1 — Glassbox "view changes": a worktree/branch selector

Default stays the **main worktree** (integrated history + the owner's uncommitted
changes). Add the ability to point Glassbox at:

- a specific **worker's worktree/branch** (review its uncommitted + committed
  work in place), or
- the **diff of a worker branch vs. the target** (`hotsheet/worker-N` …
  `<target>`) — exactly "what would integrating this branch add."

This is the review step that pairs with the integration flow: *"show me what
worker-1 did, then integrate."* It plugs directly into the HS-9045 merge-pending
badge (a completed ticket carrying `pending_integration`) and the HS-9048
`integrateBranch` call — review, then integrate, from one surface.

Mechanics:
- Glassbox already takes a project/working dir; extend the launch to accept a
  **target worktree path or branch** (resolve the worktree path for a
  `hotsheet/*` branch via `listWorktrees`). Reuse `detectTargetBranch` for the
  "vs. target" diff base.
- Surface the selector where review happens: a "Review" affordance on the
  worker-pool tile (§102.3) and/or on the merge-pending badge, pre-targeting that
  worker's branch.

## 102.3 Part 2 — Per-worker git state on the pool tile

Surface each worker's branch state on its **worker-pool panel tile**
(`src/client/workerPoolPanel.tsx`), not the sidebar chip:

- **Ahead/behind** vs. the target — HS-9048's `listReadyBranches`
  (`src/workers/integrate.ts`) already computes ahead/behind per `hotsheet/*`
  branch; reuse it.
- **Dirty** — add a porcelain (`git status --porcelain`) check per worker
  worktree (the same signal the §99 refresh + §89.7 integrate guards use).
- Render a compact chip per tile: e.g. `↑3 ↓1 •dirty` so the owner sees at a
  glance **who has unmerged / uncommitted work**.

Optionally, a **"worktrees" git summary** in the sidebar git popover (a small
expandable list of worktrees + their ahead/behind/dirty) — kept out of the chip
itself, available on demand. This gives the cross-worktree picture without
overloading the single-project chip.

## 102.4 Data / endpoints

- **Reuse `listReadyBranches`** for ahead/behind (already computed).
- **Add a per-worktree dirty check** — either extend the pool-state response
  (`GET /api/workers/pool`) with a `git` summary per slot (ahead/behind/dirty), or
  a small `GET /api/worktrees/git` that returns the per-worktree state for the
  panel + popover to render. Lean: fold it into the pool state the panel already
  polls, so no extra round-trip.
- **Glassbox target** — extend the launch payload with an optional worktree
  path / branch + diff base.

## 102.5 Open questions

- Whether to fold the per-worktree git summary into the existing pool poll (lean
  yes) or a dedicated endpoint.
- Glassbox's exact diff-base UX: review-in-worktree vs. branch-vs-target diff —
  offer both, default to branch-vs-target for the "before integrate" case.
- Refresh cadence for the dirty/ahead-behind chips (the panel polls every ~3 s;
  per-worktree `git` calls × N workers should stay cheap — batch them server-side).
- Whether a non-pool worktree (a manually-created one, §89 Phase B) also gets the
  state chip in the worktrees panel (likely yes, reuse the same summary).

## 102.6 Tests

- Unit: per-worktree git summary (ahead/behind from `listReadyBranches` + dirty
  from porcelain) over a real temp repo with a worker branch ahead + dirty.
- Unit/e2e: the pool tile renders the `↑/↓/dirty` chip from the pool state.
- e2e: the Glassbox launch carries the selected worker branch / diff base.
- Manual-test-plan: the actual Glassbox review render + live chip updates.

## 102.7 Follow-up tickets

- **Per-worktree git summary** (ahead/behind + dirty) folded into the pool state +
  the tile chip (§102.3-102.4). ✅ SHIPPED (HS-9081).
- **Glassbox worktree/branch target selector** (diff a worker branch vs. the target
  before integrating) (§102.2), wired from the pool tile. ✅ SHIPPED (HS-9082).
- **(follow-up) Glassbox review-in-worktree mode** — launch with `cwd = worktree`
  to review a worker's in-place state. **HS-9106**.
- **(follow-up) Merge-pending badge Review** affordance pre-targeting the ticket's
  branch (needs a ticket→branch mapping). **HS-9107**.
- **(Optional) worktrees git summary** in the sidebar git popover (§102.3).
- Relates: HS-9040 (investigation), HS-9045 (merge-pending), HS-9048
  (`integrateBranch` / `listReadyBranches`), §48 (git chip).

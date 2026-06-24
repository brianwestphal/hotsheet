# 91. Worker-Pool Dynamic Scaling + AI-Suggested N

**Status: PARTIAL — the pool manager + minimal panel SHIPPED 2026-06-23 (HS-8962).**
§91.2-91.5 implemented: the in-memory pool manager (`src/workers/poolManager.ts`),
the `/api/workers/pool*` endpoints, drain-aware `claim-next`, the `hotsheet-worker`
skill honoring the drain signal, and the worker-pool panel
(`src/client/workerPoolPanel.tsx`, opened from the git popover). Still design-only:
AI-suggested N (§91.6 → HS-8963), the §90.8 live event bus (HS-7945; polling for
now), the dispatch drop targets (§92 → HS-8961), and the richer claimed-by chip
(HS-8864). The runtime management layer over the durable worktree worker pool from
[90-distributed-execution.md](90-distributed-execution.md) §90.7 and
[89-git-worktrees.md](89-git-worktrees.md) §89.2 Phase D.

## 91.0 Goal

Let the maintainer set and change the number of parallel workers draining the Up
Next pool, on demand, without ever interrupting a worker mid-ticket — and get an
AI recommendation for a sensible worker count before kicking off a batch. The pool
is **durable per-worker slots** (decided in §90.7): N long-lived worktrees, each
running the §90.5.1 / HS-8863 claim→work→complete→release loop.

## 91.1 Relationship to other work

- **[§90](90-distributed-execution.md) §90.7** — defines the durable pool + this
  feature at a high level; this doc is the detailed design.
- **[§89](89-git-worktrees.md) Phase B/C (shipped)** — a worker slot IS a git
  worktree (HS-8935 `createWorktree`/`removeWorktree`) + a per-worktree AI
  terminal (HS-8936). Scaling reuses those primitives; it does not invent a new
  isolation mechanism.
- **HS-8862 / HS-8863** — the claim primitive + the worker loop a slot runs.
- **HS-8961 ([§92](92-coordinator-dispatch.md))** — dispatch UX shares the same
  worker-pool panel surface defined here (§91.4).

## 91.2 The pool model

A **pool** belongs to one authoritative project. A **worker (slot)** = one git
worktree + one AI terminal running the claim loop, with a stable owner-visible
`worker_label` (e.g. `worker-1`; see §90.2.1). The pool has a target size `N`
(the desired worker count) and an actual set of live workers; scaling reconciles
actual toward target without disrupting in-flight tickets.

Worker states (for the UI): `starting` (worktree/terminal being created) →
`idle` (loop running, nothing claimed) ⇄ `working` (holds a claimed ticket, lease
live) → `draining` (asked to stop; finishing its current ticket) → `stopped`
(loop ended, worktree removable).

## 91.3 Scale up

Adding a worker = §89 Phase B/C, automated:
1. `createWorktree(...)` (HS-8935) at a pool-conventional path
   (e.g. `<repo>/../<repo>-worktrees/worker-<n>`; final convention is a §89.5
   open question) on a fresh per-worker branch, writing the follower pointer to
   the owner `.hotsheet`.
2. Open an AI terminal in that worktree (HS-8936) running the claim loop
   (HS-8863), which immediately `claim-next`s and starts draining.

Scale-up is incremental and non-blocking — existing workers keep going.

## 91.4 Scale down (graceful drain) — ✅ SHIPPED (HS-8962)

**Implemented mechanism (the "drain flag the loop checks before its next
`claim-next`"):** the pool manager marks a worker `draining`; the **`claim-next`
route** consults `poolManager.onClaimNext(dataDir, worker)` and, for a draining
worker, returns `{ticket:null, drain:true}` instead of claiming and flips the slot
to `stopped`. Because the worker only learns it at its *next* pull, it always
finishes the ticket it was already on. The `hotsheet-worker` skill honors
`drain:true` by signaling done + stopping; the panel then closes the terminal +
`removeWorktree`. A wedged worker that never pulls again is reclaimed via lease
expiry (§90.2.2). Non-pool workers are never drained (`onClaimNext` returns
`drain:false` for any worker not in the registry).

**Never kill a worker mid-ticket.** Scaling down marks a worker `draining`; it:
1. Stops claiming new tickets (the loop checks a drain flag before the next
   `claim-next`).
2. Finishes its current ticket → `release` (or, if it's idle, drains
   immediately).
3. The terminal is closed and the worktree removed (`removeWorktree`, HS-8935 —
   branch kept per the §89.5 default).

If the maintainer cancels the drain before the ticket completes, the worker
returns to `working`/`idle`. A force-stop affordance exists for a wedged worker,
but it relies on lease expiry (§90.2.2) to reclaim the abandoned ticket rather
than losing it.

## 91.5 The worker-pool panel (UI) — ✅ SHIPPED (minimal, HS-8962)

Shipped as a **sibling panel** `src/client/workerPoolPanel.tsx`, opened from the
git popover's "Worker pool…" button (next to "Manage worktrees…"). It renders a
tile per worker (label, state chip, current ticket from the live claims), a
**target-N stepper** (`−  N  +` + "X running", HS-8971) the panel reconciles
toward, a per-worker "Drain", and "Drain all". **Reconcile (HS-8971):** on every
refresh `reconcile()` compares the live count (idle+working, plus in-flight adds)
to the server's `targetN` and launches workers when below / gracefully drains the
surplus (idle first) when above; a failed launch lowers the target by one so it
doesn't retry forever. Target-N is the server's in-memory `targetN`
(`setPoolTarget`/`POST /api/workers/pool/target`) — session-only (§91.9). A worker
that has acknowledged its drain (`stopped`) is auto-cleaned (close terminal +
`removeWorktree` + unregister). Tiles refresh by polling every 3 s. Still to layer
on (separate tickets): the §92 dispatch drop targets (HS-8961), the richer
claimed-by/lease-freshness chip (HS-8864), and the §90.8 live event bus
(HS-7945, replacing the poll). Original design intent below:

Extends the existing worktrees panel (`src/client/worktreesPanel.tsx`, HS-8938)
into a pool dashboard (or a sibling panel reachable from it):
- A tile per worker: `worker_label`, state chip, current ticket (HS-NNNN +
  title) with a lease-freshness indicator (reuses the §90.8 / HS-8864 claimed-by
  chip), and per-worker actions (open its terminal, drain).
- Pool controls: a target-N stepper / "+ add worker" / "drain one", a "drain all"
  (stop the pool gracefully), and the **AI-suggest N** button (§91.6).
- Live progress: tiles update as workers claim/release (poll today; the §90.8
  HS-7945 event bus once it ships).
- The dispatch surface (§92) hangs off these tiles (drag tickets onto a tile).

## 91.6 AI-suggested N — ✅ SHIPPED (HS-8963)

A recommendation, never an automatic action — the owner always sets the actual N.

**Implemented** in `src/workers/suggestN.ts` + `GET /api/workers/suggest-n` + an
"AI: suggest" button in the pool panel. It fetches the unblocked Up Next set (+ a
count of blocked ones for context, via `BLOCKED_TICKET_IDS_SQL`), builds a compact
digest, and asks Anthropic (the announcer key + Messages-API/json-schema pattern,
cheap Haiku model) for `{n, rationale}`; `n` is clamped to `[1, POOL_MAX]`
(`poolMax()` = CPU-cores−2, floored 1, capped 8). The panel shows the rationale in
a confirm dialog and applies it via `setPoolTarget` only if the owner accepts.
**Fallback:** with no Anthropic key (or on an AI error) a deterministic cluster
heuristic (`heuristicSuggestion` — group unblocked tickets by shared
category/tag) returns a labeled estimate so the button always works. (Local/Apple
announcer providers aren't wired for this call yet — Anthropic-or-heuristic only.)

- **Trigger:** an "AI: suggest worker count" button in the pool panel (and/or a
  one-shot before launching a batch).
- **Inputs:** the current Up Next set (the same priority-ordered pool `claim-next`
  draws from) + the flat `blocked_by` graph (HS-8865).
- **Heuristic (design-level; specifics tunable):** estimate how many tickets can
  progress *independently in parallel right now* — i.e. the count of unblocked Up
  Next tickets that don't obviously collide, minus coupling. Coupling signals:
  shared `blocked_by` lineage, shared tags/category, and (best-effort) overlapping
  file/area hints from ticket text. Recommend `N = clamp(independentClusters, 1,
  POOL_MAX)` where `POOL_MAX` is a small machine-sensible cap (e.g. CPU-cores-based,
  matching the §workflow concurrency cap pattern). Return the number **plus a
  one-line rationale** ("6 unblocked, ~3 independent clusters → 3").
- **Implementation:** runs as an AI call through the existing channel/announcer
  AI plumbing (a dedicated prompt over the pending-ticket digest), not a
  hand-rolled estimator — so it improves with the model. The exact prompt +
  clustering approach is left to implementation (§91.8).

## 91.7 Safety / edge cases

- **Empty pool:** workers idle-and-back-off when `claim-next` returns nothing
  (HS-8863); the panel shows "nothing to claim". No busy-spin.
- **Crash / zombie slot — ✅ SHIPPED (HS-8972):** a dead worker's *ticket* is
  reclaimed via lease expiry (§90.2.2); its *slot* now self-heals too. Each slot
  carries a `lastSeenAt`, bumped on every sign of life (`claim-next`, lease renewal,
  claim-by-id); a slot silent past `STALE_AFTER_MS` (5 min — comfortably above the
  120 s lease TTL + renew cadence) is derived as **`dead`** in `GET /api/workers/pool`.
  The panel auto-reaps a `dead` slot (close terminal + `removeWorktree` +
  unregister, the same teardown as `stopped`) with a toast, and the §91.5 reconcile
  then recreates a replacement if still below target N. A worker heads-down on a
  long ticket stays live (it renews); one that's truly silent has already lost its
  lease, so reaping it is safe.
- **Single-local default untouched:** the pool is opt-in; with N=0 / no pool,
  behavior is exactly today's single-agent flow.
- **Single-machine scope:** all workers run on this box against the local server;
  off-box scaling is the §46 remote extension, out of scope here.
- **Disk/branch hygiene:** scale-down removes worktrees but keeps branches by
  default (§89.5); a "remove branch too" option mirrors the Phase B API
  `deleteBranch`.

## 91.8 Tests

- Unit: drain-flag logic (a `draining` worker finishes its ticket then stops; an
  idle one stops immediately); target-N reconciliation (add/remove to hit N);
  AI-N clamp/rationale formatting (pure function over a ticket digest).
- Integration: scale 0→3 drains a 3-ticket pool in parallel with no double-work;
  drain-one mid-ticket completes that ticket before removing the worktree.
- Manual-test-plan: the visual pool dashboard + live tile updates (hard to fully
  automate).

## 91.9 Open questions

- Worktree path/branch naming convention for pool slots (shared with §89.5).
- `POOL_MAX` derivation (CPU cores − 2, like the Workflow concurrency cap? a
  fixed small default? user-configurable?).
- AI-N clustering specifics (graph-only vs file-overlap heuristics vs full-text
  reasoning) — start simple (unblocked count + `blocked_by` clusters), iterate.
- Should target-N persist per project (resume the pool on relaunch) or be
  session-only? Lean session-only for v1.

## 91.10 Follow-up tickets

(1) pool manager + scale up/down + drain (server) and (2) the worker-pool panel UI
shipped together in **HS-8962** (2026-06-23); the numeric target-N stepper +
auto-reconcile shipped in **HS-8971** (2026-06-23); dispatch drop targets shipped in
**HS-8964** (§92); the claimed-by/lease chip shipped in **HS-8864** (§90.8); the
zombie-slot liveness reap shipped in **HS-8972** (§91.7); the AI-suggest-N helper
shipped in **HS-8963** (§91.6). Remaining: swapping the poll for the §90.8 live
event bus (**HS-7945**), and (optional) local/Apple-provider parity for the
AI-suggest call.

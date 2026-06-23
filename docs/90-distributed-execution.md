# 90. Distributed Ticket Execution (claim / lease + worker pool)

**Status: PARTIAL — design + the claim/lease primitive (HS-8862) SHIPPED
2026-06-23.** §90.2-90.4 (schema, endpoints, MCP tools, lease sweep) are
implemented (see §90.10 item 1); the worker loop / pool / dispatch / UI
(§90.5-90.8) remain design-only. HS-8861 spike resolved here; supersedes the
"finalize the claim model" half of HS-8861. No code this pass. This doc pins the
concrete schema, endpoints, MCP tools, lease semantics, coordination models, and
the dynamically-scaled worker pool that [89-git-worktrees.md](89-git-worktrees.md)
§89.2 Phase D consumes as its isolation layer.

Decisions taken from HS-8937 feedback (2026-06-23):
- **Resolve the claim model in its own doc first** (this one), then layer Phase D
  on top — feedback (1b).
- **Support BOTH coordination models** — autonomous self-claim *and*
  owner-directed dispatch — feedback (2).
- **Durable per-worker pool with dynamic scaling up/down**, with an AI-assisted
  "how many workers for this batch" sizing helper — feedback (3a + scaling).
- **Single-machine first** — N workers against the local server; off-box workers
  are a later extension gated on the §46 remote epic — feedback (4a).

## 90.0 Goal

Let multiple workers (Claude/agent terminals today; off-box workers later) drain
the **Up Next** pool in parallel against the ONE shared Hot Sheet server, each
working in isolation, while every claim/progress/completion still flows through
the normal API/MCP path so the maintainer's UI watches it all happen live — the
same way a single local agent updates tickets today.

The unit of isolation is a git worktree ([§89](89-git-worktrees.md)); the unit of
*coordination* is the claim/lease primitive defined here. The two are separable:
the claim primitive is useful even for a single agent serializing its own loop,
and worktrees are useful without parallelism (Phases A–C, shipped).

## 90.1 Scope & non-goals

**In scope (this design):** the claim/lease schema + endpoints + MCP tools; lease
expiry/reclaim; the flat dependency gate that keeps parallel workers from grabbing
dependents early; both coordination models; the durable, dynamically-scaled worker
pool; observability + safety.

**Non-goals (deferred):**
- **Off-box / remote workers** — needs the [§46](46-service-client-decoupling.md)
  epic (HS-7940 bind+auth, HS-7944 service-only, HS-7945 WebSocket bus). All of
  §46 is **design-only** today. Single-machine multi-worker runs against the
  existing local server without it, so Phase D ships first single-machine.
- **Hierarchical sub-tasks** — permanently out (tried + reverted 2026-03-23). The
  planning gate is a FLAT `blocked_by` list (§90.7), never a parent/child tree.
- **Cross-project workers** — a worker operates within one authoritative project
  (mirrors the §89 follower-points-at-one-owner rule).

## 90.2 Claim / lease model

### 90.2.1 Schema (orthogonal to `status`/`up_next`)

Add four nullable columns to `tickets` via the existing idempotent
`ALTER TABLE … ADD COLUMN IF NOT EXISTS` migration block in
`initSchema()` (`src/db/connection.ts`, alongside the `notes`/`tags`/`verified_at`
additions):

```sql
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claimed_by TEXT;                 -- worker identity (clientId or worker_label); NULL = unclaimed
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claim_lease_expires_at TIMESTAMPTZ; -- lease deadline; past = reclaimable
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS worker_label TEXT;               -- human-friendly worker name for the UI (e.g. "worktree-2")
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS claim_count INT NOT NULL DEFAULT 0; -- times claimed; >1 hints at churn / repeated reclaim
```

**Orthogonal by design:** when unused (`claimed_by IS NULL`), behavior is
identical to today — the single-local-maintainer default never sees a claim. A
claim does NOT change `status`/`up_next`; a claimed ticket is still "Up Next,
started" — it just additionally carries a live lease.

### 90.2.2 Lease semantics

A claim without a lease leaks forever if a worker dies. Each claim carries a TTL:

- **TTL:** reuse the Announcer live-mode lease shape (`src/announcer/liveGenerator.ts`,
  `LIVE_LEASE_MS = 90_000`). Default **claim lease = 120 s** (a unit of agent work
  is longer than a "still listening" heartbeat; tune in implementation).
- **Renewal (heartbeat):** the worker calls `renew-lease` on a cadence well inside
  the TTL (e.g. every 30–45 s) while it holds the ticket. Renewal just pushes
  `claim_lease_expires_at = now() + TTL`.
- **Expiry + reclaim:** two complementary mechanisms, mirroring the Announcer's
  lazy-prune + the §75 scheduler:
  1. **Lazy:** `claim-next`/`claim` treat a ticket whose
     `claim_lease_expires_at < now()` as unclaimed (claimable), so a dead worker's
     ticket is naturally re-grabbed without a sweep.
  2. **Active sweep:** a periodic job registered with the §75 background scheduler
     (`backgroundScheduler.submit({ key: 'lease-sweep:<dataDir>', priority:
     PRIORITY.GC, deferUnderLag: true, … })`) clears expired claims
     (`claimed_by = NULL`) and appends a `lease expired — reclaimed` note so the
     maintainer sees a worker died, and emits a release event (§90.5).
- **Reclaim's effect on `status`:** **none** — leave `status` as the worker left
  it. A reclaimed ticket is whatever state the dead worker last synced (often
  `started`); it stays Up Next and becomes claimable again. We do NOT auto-revert
  to `not_started` (that would clobber real progress); the reclaim note is the
  signal.

### 90.2.3 Atomic `claim-next` + selection policy

The core anti-double-claim primitive is Postgres `SELECT … FOR UPDATE SKIP
LOCKED` — self-contained, correct under concurrent workers, no extra coordination:

```sql
-- inside a transaction
WITH next AS (
  SELECT id FROM tickets
   WHERE up_next = TRUE
     AND status NOT IN ('completed','verified','deleted')
     AND (claimed_by IS NULL OR claim_lease_expires_at < NOW())
     AND id NOT IN (SELECT ticket_id FROM ticket_blocked_by WHERE NOT resolved)  -- §90.7 gate
     -- optional body filters: category, tag, worker affinity
   ORDER BY <PRIORITY_ORD> ASC, id DESC          -- MATCHES the Up Next worklist order
   FOR UPDATE SKIP LOCKED
   LIMIT 1
)
UPDATE tickets t SET claimed_by = $worker, worker_label = $label,
       claim_lease_expires_at = NOW() + $ttl, claim_count = claim_count + 1
  FROM next WHERE t.id = next.id
RETURNING t.*;
```

`<PRIORITY_ORD>` is the **same** `CASE priority …` ordinal the worklist uses
(`src/db/tickets.ts`, `highest→lowest = 1→5`, then `id DESC`), so a worker always
claims the ticket the maintainer would see at the top of Up Next. Returns the
claimed ticket, or empty when nothing is claimable.

### 90.2.4 Claim-by-id + conflict

`claim` (a specific ticket, used by dispatch mode §90.4) takes the same lock; if a
*live* lease is held by another worker it returns **409 Conflict** with the
current `claimed_by`/`worker_label`. This composes with HS-7946's
`If-Match`/`version` optimistic-concurrency primitive **once that ships** (it is
design-only today); until then the live-lease check is the guard.

## 90.3 Endpoints

Server routes (typed callers live in `src/api/tickets.ts` per the §9 convention;
`claimNextTicket()` / `claimTicket(id)` / `renewLease(id)` / `releaseTicket(id)`):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/tickets/claim-next` | Atomically claim the top claimable Up Next ticket (§90.2.3). Optional body filters: `category`, `tag`, `worker_label`. Returns the ticket or `{ claimed: null }`. |
| `POST` | `/api/tickets/:id/claim` | Claim a specific ticket (dispatch). 409 on a live foreign lease. |
| `POST` | `/api/tickets/:id/renew-lease` | Worker heartbeat — extend the lease. 409 if the lease was reclaimed by someone else. |
| `POST` | `/api/tickets/:id/release` | Drop the claim (on complete, or hand back). Idempotent. |
| `GET` | `/api/tickets/claims` | List currently-claimed tickets `{ ticketId, claimed_by, worker_label, lease_expires_at }` for the claimed-by UI (§90.6) and the worker-pool panel. |

**Safety:** claim mutation endpoints follow the same secret/origin enforcement as
the rest of the API; when (later) bound non-localhost they require the §46 auth.
The single-local default is unaffected — nothing calls these unless a worker pool
or a claiming agent is running.

## 90.4 MCP tools

So a worker agent drives the loop with the same `hotsheet_*` surface it already
uses, add three tools to the `TOOLS` array in `src/channel.tools.ts`:

- `hotsheet_claim_next` — claim the next ticket (returns it or "nothing
  claimable"); the worker then works it.
- `hotsheet_renew_lease` — heartbeat while working a long ticket.
- `hotsheet_release` — release on completion/handback (typically paired with the
  existing `hotsheet_update_ticket status=completed`).

Bump **both** `CHANNEL_VERSION` (`src/channel.ts`, currently 11) and
`EXPECTED_CHANNEL_VERSION` (`src/channel-config.ts`, currently 11) together to 12
(per the CLAUDE.md rule), and document the tools in
[63-mcp-tools.md](63-mcp-tools.md).

## 90.5 Coordination models — BOTH supported

The claim primitive supports two complementary modes against the SAME schema;
they differ only in *who decides which ticket a worker gets*:

### 90.5.1 Self-claim (pull) — the default

Each idle worker calls `claim-next` and gets the top claimable ticket. The
"coordinator" is thin: it only spawns/monitors the worker terminals; it does not
assign work. Best for a homogeneous backlog where any worker can take anything.
This is the autonomous drain-the-pool loop.

### 90.5.2 Coordinator-dispatch (push) — owner partitioning

The owner (or an AI planning pass) assigns specific tickets to specific workers
via `claim` (claim-by-id on the worker's behalf), e.g. grouping *related* tickets
onto one worker to keep a coherent change set in one worktree, or steering a
specialized worker. The dispatcher holds the claim, the worker works it. Detailed
UX in [92-coordinator-dispatch.md](92-coordinator-dispatch.md) (HS-8961).

Both modes coexist: a dispatched (pre-claimed) ticket is simply skipped by other
workers' `claim-next` (it has a live lease); an undirected worker keeps pulling.
The owner can dispatch a few related chunks and let the rest self-drain.

## 90.6 Planning / dependency gate (flat `blocked_by`)

To stop parallel workers grabbing a ticket whose prerequisite isn't done, the
planning phase emits a **flat** dependency list (HS-8865), not a tree:

- New `ticket_blocked_by (ticket_id, blocks_on_ticket_id)` join table (a ticket is
  blocked while any `blocks_on` ticket is not `completed`/`verified`).
- `claim-next` excludes blocked tickets (the `NOT IN (…)` clause in §90.2.3).
- Resolving the last blocker makes a ticket claimable on the next pull — no
  re-planning needed.

Flat only — **no hierarchical sub-tasks** (reverted 2026-03-23).

## 90.7 Worker pool + dynamic scaling (the Phase D consumer)

This is what [§89](89-git-worktrees.md) Phase D builds. A **durable per-worker
pool**: N long-lived worktrees, each with an AI terminal looping
`claim-next → work → complete + release → repeat`. Durable (not per-ticket
ephemeral) to avoid git/worktree churn; cleanup happens when the pool scales down,
not per ticket. Detailed design in
[91-worker-pool-scaling.md](91-worker-pool-scaling.md) (HS-8960).

- **Dynamic scale up/down:** the owner can add or drain workers at any time.
  Scaling up = create a worktree + terminal (Phase B/C) and start the loop;
  scaling down = stop a worker *after its current ticket releases* (graceful), then
  remove its worktree. The pool size N is not fixed at launch.
- **AI-assisted sizing:** before a batch, the owner can ask the AI to suggest a
  reasonable N for the upcoming Up Next set (e.g. by independent-vs-coupled
  analysis of the pending tickets + the `blocked_by` graph) — a recommendation,
  the owner sets the actual N.
- **Lifecycle:** a worktree is a durable pool slot, NOT created per claimed ticket
  (resolves the §89.5 lifecycle-coupling open question in favor of durable pool).
  Per-ticket ephemeral worktrees are explicitly rejected for the churn cost.

## 90.8 Observability

- **Claimed-by chip (HS-8864):** each in-flight ticket shows which worker/worktree
  holds it (`worker_label`) + a lease freshness indicator, so the maintainer sees
  the parallel work live — the whole point of routing through the normal API.
- **Worker-pool panel:** list workers, their current ticket, lease health;
  scale-up/down controls; the AI-suggested-N helper.
- **Events:** emit `ticket-claimed` / `lease-renewed` / `ticket-released` on the
  HS-7945 WebSocket bus **once it ships**; until then the existing poll path
  surfaces the `claimed_by` columns like any other field change.

## 90.9 Relationship to other docs

- [89-git-worktrees.md](89-git-worktrees.md) — Phase D is the worktree application
  of this primitive; Phases A–C (shipped) are the isolation substrate.
- [46-service-client-decoupling.md](46-service-client-decoupling.md) — required
  ONLY for off-box workers (remote bind+auth, service-only, WebSocket bus,
  optimistic concurrency). All design-only; single-machine Phase D does not need
  it.
- [75-background-work-scheduler.md](75-background-work-scheduler.md) — the lease
  expiry sweep registers here.
- [80-announcer-live-mode.md](80-announcer-live-mode.md) — the lease TTL/renewal
  pattern reused for claims.
- [63-mcp-tools.md](63-mcp-tools.md) — the three new worker MCP tools.

## 90.10 Phasing / implementation tickets

1. **Claim/lease primitive (HS-8862)** — ✅ **SHIPPED** (2026-06-23): the four
   `tickets` columns + `src/db/claims.ts` (`claimNext`/`claimById`/`renewLease`/
   `release`/`getClaims`/`sweepExpiredClaims`), the five `POST /tickets/claim-next`
   `/:id/claim` `/:id/renew-lease` `/:id/release` + `GET /tickets/claims` endpoints
   (typed in `src/api/tickets.ts`), the 3 MCP tools (`CHANNEL_VERSION` → 12), and
   the 60 s lease-sweep timer (`src/claims/leaseSweepTimer.ts`). Tests:
   `db/claims.test.ts` (9), `routes/api.test.ts` claim block (4),
   `channel.tools.test.ts` (+4), `claims/leaseSweepTimer.test.ts` (4).
2. **Flat `blocked_by` planning gate (HS-8865)** — the dependency table + the
   `claim-next` exclusion + a planning pass that populates it.
3. **Distributed worker loop (HS-8863)** — the per-worker `claim → work → release`
   loop driving an agent terminal.
4. **Claimed-by / in-flight UI (HS-8864)** — the chip + worker-pool panel.
5. **Phase D wiring** — the durable worktree pool composing 1–4 with §89 Phases
   A–C: the per-worker claim→work→complete loop is HS-8863; the worktree+terminal
   slot is §89 Phase B/C (shipped). (This doc + §89 Phase D is HS-8937's design
   deliverable; HS-8937 itself is design-complete.)
6. **Worker-pool dynamic scaling + AI-suggested N (HS-8960 →
   [§91](91-worker-pool-scaling.md))** — scale up/down + batch sizing; the
   pool-management layer over HS-8863 workers.
7. **Coordinator-dispatch UX (HS-8961 →
   [§92](92-coordinator-dispatch.md))** — owner partitions related chunks onto a
   worker (the push half of §90.5).
8. **Remote extension (§46 epic, HS-7940/7944/7945/7946)** — off-box workers.

## 90.11 Open questions

- Exact lease TTL + renewal cadence (start 120 s / 40 s; tune under real agent
  runtimes).
- `claim-next` fairness when the owner mixes dispatch + self-claim heavily (is
  starvation possible for low-priority self-claim workers? likely fine given the
  small N).
- Whether `worker_label` should be owner-assigned (stable "worktree-2") or
  worker-generated; lean owner-assigned for a readable UI.
- AI-suggested-N heuristic specifics (left to the HS-8937 implementation).

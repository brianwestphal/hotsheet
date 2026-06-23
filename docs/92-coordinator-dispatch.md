# 92. Coordinator-Dispatch UX (owner assigns ticket chunks to a worker)

**Status: DESIGN ONLY** (HS-8961, 2026-06-23). The "push" half of the dual
coordination model from [90-distributed-execution.md](90-distributed-execution.md)
§90.5.2 — the owner manually partitions work onto specific workers, complementing
autonomous self-claim. Gated on the claim primitive's claim-by-id (HS-8862) + the
worker-pool panel (HS-8960 §91.5) + the claimed-by UI (HS-8864); no code this pass.

## 92.0 Goal

Self-claim (§90.5.1) is great for a homogeneous backlog, but sometimes the owner
wants a *coherent change set in one worktree* — e.g. group several RELATED tickets
onto one worker so they land together on one branch. This is owner-directed
dispatch: assign chosen Up Next tickets to a chosen worker, which then works them
in order. Both modes coexist (§92.4).

## 92.1 Relationship to other work

- **[§90](90-distributed-execution.md) §90.5.2** — defines dispatch + the
  claim-by-id endpoint (`POST /api/tickets/:id/claim`, 409 on a live foreign
  lease); this doc is the UX detail.
- **[§76](76-cross-project-ticket-drag.md) cross-project ticket drag (shipped,
  HS-8663)** — the interaction precedent: drag selected tickets onto a target.
  Dispatch mirrors it (drag onto a worker tile instead of a project tab).
- **[§91](91-worker-pool-scaling.md) worker-pool panel** — the drop targets
  (worker tiles) live here.
- **HS-8864** — the claimed-by chip that shows the resulting assignment.

## 92.2 Dispatch interaction model

Two entry points, mirroring existing conventions:

1. **Drag-to-worker (primary)** — reuse the §76 drag machinery: ticket rows /
   column cards already publish the dragged set via `setDraggedTicketIds(...)`
   on `dragstart`. A **worker tile** in the pool panel (§91.5) becomes a drop
   target: hovering with a ticket drag in flight lights it (`.drag-over`, the §76
   single-slot highlight), and dropping dispatches the dragged tickets to that
   worker. `dropEffect = 'move'` (the ticket leaves the unclaimed pool for that
   worker), distinct from §76's copy-to-project default.
2. **Multi-select → "Dispatch to…" menu (fallback / discoverable)** — the
   existing ticket context menu / batch bar gains a "Dispatch to worker ▸"
   submenu listing live workers (Tauri-safe; drag is unreliable for some flows).

Both resolve to the same server action (§92.3).

## 92.3 Server: claim-by-id on the worker's behalf

Dispatch is **claim-by-id where the claimer is the target worker, not the caller**.
`POST /api/tickets/:id/claim` (HS-8862) accepts the target `worker_label`/identity
so the dispatcher (the owner's UI) sets `claimed_by = <that worker>` + a lease.
The worker's loop, on its next iteration, sees it already holds the ticket (or is
handed it) and works it — its `claim-next` is effectively pre-satisfied.

- **Conflict:** if the ticket already has a live lease (another worker), return
  **409** with the current holder; the UI surfaces "already claimed by worker-2".
- **Lease ownership:** the dispatched worker is responsible for renewing the lease
  once it picks the ticket up; until then the dispatcher's initial lease covers it
  (a short grace), and lease expiry (§90.2.2) reclaims it if the worker never
  does (e.g. it was drained).

## 92.4 Coexistence with self-claim

A dispatched ticket carries a live lease, so other workers' `claim-next` (which
skips claimed-or-leased tickets, §90.2.3) naturally pass it over — no special
casing. The owner can dispatch a few related chunks and let the rest of the pool
self-drain the remainder. Mixed mode is the expected default.

## 92.5 Showing the assignment

- The ticket's **claimed-by chip** (§90.8 / HS-8864) shows the assigned
  `worker_label` immediately on dispatch.
- The **worker tile** (§91.5) lists its assigned/queued tickets in order.
- If a worker has multiple dispatched tickets, they form its personal queue; it
  works them before falling back to self-claim (a dispatched worker prefers its
  queue, then pulls from the shared pool unless told to stop after its queue).

## 92.6 AI "partition into N coherent chunks" helper (optional)

A convenience over manual dragging: select a set of Up Next tickets (or the whole
pool) and ask the AI to group them into N coherent chunks (by relatedness — shared
area/tags/`blocked_by` lineage), then dispatch each chunk to a worker. Reuses the
§91.6 AI-suggest-N analysis (same relatedness signals) but emits a *partition*
(assignments) rather than a *count*. The owner reviews/edits the proposed
partition before it's applied. Specifics left to implementation; this is additive
to manual dispatch, not a prerequisite.

## 92.7 Edge cases

- **Dispatch a blocked ticket:** allowed but flagged — it sits in the worker's
  queue and isn't worked until its `blocked_by` (HS-8865) clears; the UI warns.
- **Dispatch to a draining/stopped worker:** rejected (the tile isn't a valid
  drop target while `draining`/`stopped`).
- **Reassign / recall:** dragging a dispatched ticket to another worker re-claims
  it to that worker (if not yet in progress); dropping it back on the unclaimed
  pool / a "release" affordance clears the claim (back to self-claimable).
- **Single-local default untouched:** dispatch only appears when a worker pool
  exists; with no pool there are no drop targets.

## 92.8 Tests

- Unit: drop-target highlight + dispatch action resolves to claim-by-id with the
  right worker; "Dispatch to…" menu lists only live (non-draining) workers; 409
  surfaces "already claimed by X".
- Integration: dispatch 2 related tickets to worker-1 while worker-2 self-claims
  the rest → no overlap, worker-1's land on its branch.
- E2E (Tauri-safe): use the menu path (not raw HTML5 drag) per the §76 / CLAUDE.md
  Tauri-drag caveat; assert the claimed-by chip appears.
- Manual-test-plan: the drag-to-tile visual flow + AI-partition review.

## 92.9 Open questions

- Does a dispatched worker, after finishing its queue, fall back to self-claim by
  default, or stop? Lean: fall back (keep draining the pool) unless the owner set
  it queue-only.
- Worker-queue ordering when multiple tickets are dispatched at once — priority
  order, or drop order? Lean priority (consistency with `claim-next`).
- Whether the AI-partition helper ships with v1 or as a later add-on (it's
  additive; manual dispatch is the core).

## 92.10 Follow-up tickets

Implementation gated on HS-8862 (claim-by-id) + HS-8960 (worker-pool panel) +
HS-8864 (claimed-by chip). When unblocked, likely: (1) worker-tile drop target +
"Dispatch to…" menu wired to claim-by-id, (2) worker personal-queue semantics in
the loop (HS-8863), (3) the AI-partition helper. File when gating primitives land.

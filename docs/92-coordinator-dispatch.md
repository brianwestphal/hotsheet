# 92. Coordinator-Dispatch UX (owner assigns ticket chunks to a worker)

**Status: PARTIAL — manual dispatch + reassign/recall SHIPPED 2026-06-24 (HS-8964,
HS-8974).** The "push"
half of the dual coordination model from
[90-distributed-execution.md](90-distributed-execution.md) §90.5.2 — the owner
manually partitions work onto specific workers, complementing autonomous
self-claim. §92.2-92.5 + §92.7 implemented: drag-to-worker-tile + a "Dispatch to
worker…" context-menu, both resolving to claim-by-id (HS-8862), with the
dispatched tickets forming the worker's **personal queue** (served first by
`claimNext`). The AI "partition into N coherent chunks" helper (§92.6) remains
design-only (HS-8965).

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
- **Reassign / recall — ✅ SHIPPED (HS-8974):** re-dispatching a ticket that's
  already claimed by another worker prompts "Reassign to X? (abandons in-progress
  work)" → on confirm, a **force** claim-by-id (`ClaimSchema.force` → `claimById(…,
  force)`, atomically overwriting the holder — no release-then-claim race) moves
  it. **Recall** is the "Recall claim" context-menu item (shown when any selected
  ticket is claimed) → force-release (`release(id)` with no worker) back to the
  self-claimable pool. (A "queue-only" worker mode — §92.9 — is not built; a
  dispatched worker always falls back to self-claim.)
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

## 92.10 Implementation

Shipped in **HS-8964** (2026-06-24):
1. **Drop target + "Dispatch to…" menu** — worker tiles in the pool panel
   (`src/client/workerPoolPanel.tsx`) accept a §76 ticket drag (`.drag-over`,
   `dropEffect=move`, non-draining tiles only); the ticket context menu gains an
   async "Dispatch to worker ▸" submenu listing live workers
   (`src/client/contextMenu.tsx`). Both call the shared `src/client/dispatch.ts`
   (`dispatchTicketsToWorker` → `claimTicket` per id; 409 surfaces "already claimed
   by X" via the route's new `error` field).
2. **Worker personal-queue semantics** — handled in `claimNext` itself rather than
   the loop/skill: a worker's own-claimed (dispatched) tickets are served first,
   regardless of `up_next` (docs/90 §90.5.2 / claims.ts). So the existing HS-8863
   self-claim loop drains its dispatched queue before the shared pool — no
   worker-side change.
3. **Reassign / recall (§92.7) — HS-8974** — `ClaimSchema.force` → `claimById(…,
   force)` overwrites a foreign lease atomically; `dispatchAndReport` prompts to
   reassign on conflict then force-redispatches the failed ids; a "Recall claim"
   context-menu item force-releases back to the pool. Tests: `client/dispatch.test.ts`
   (reassign confirm/decline), `db/claims.test.ts` (force overwrite + recall).
4. **AI-partition helper (§92.6)** — still design-only (**HS-8965**).

Tests: `client/dispatch.test.ts`, `db/claims.test.ts` (personal-queue ordering +
non-up_next dispatch), `client/workerPoolPanel.test.ts` (drop-target + draining
rejection).

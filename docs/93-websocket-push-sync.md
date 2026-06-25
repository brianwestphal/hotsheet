# 93. WebSocket Push Synchronization (`/ws/sync`)

HS-7945. Implementation design for the WebSocket-driven push channel that replaces the
`/api/poll` long-poll for multi-client deployments. This doc turns the high-level
synchronization sketch in [46-service-client-decoupling.md](46-service-client-decoupling.md) §46.3
into a buildable, phased spec, grounded in the code as it exists today.

> **Status (2026-06-24):** In progress. **Shipped:** HS-7940 (bind + trusted-origin auth),
> HS-8978 (server event bus §93.2), HS-8979 (`/ws/sync` endpoint §93.3/§93.7), HS-8980 (mutation
> emission §93.4 — `src/routes/syncEmit.ts`), HS-8981 (client transport §93.5/§93.6 —
> `src/client/wsSync.ts`: connect / reconnect / poll-fallback / `?since` catch-up, driving a
> coalesced full refresh per event), HS-8982 (coalescing §93.8 — `src/sync/coalesce.ts`, applied to
> the `?since` catch-up replay; live-fanout coalescing stays deferred — no flood, and the client
> already debounces), HS-8984 (per-event in-memory reducer §93.5 — `reduceMutation` applies
> `optimisticUpdate`/`removeTicket` to `ticketsStore` in place for loaded tickets, refetching only
> when a change could pull a not-loaded ticket into view or is placement-sensitive). **The whole
> WS-push stack is shipped end-to-end.** Decomposition + dependencies in §93.9.

## 93.1 Why — and why it is NOT a local win

The motivating value is **remote / multi-client**, not the single-machine default. Grounding:

- Today's `/api/poll` is **already a long-poll, not a busy poll**. The server holds the request up
  to 30s and flushes it the instant any mutation calls `notifyMutation()`
  (`src/routes/notify.ts` → `addPollWaiter` / `notifyChange`; client `src/client/poll.tsx` →
  `loadTickets()` + targeted refreshes). On the single-local default, updates are **already
  effectively instant** — there is no meaningful latency win from WebSockets locally.
- The cost the WebSocket removes is **bandwidth at N clients**: every poll wake today makes each
  client re-`GET` a full ticket list and re-derive. At one client that's cheap; at many clients,
  or over a remote link, it's wasteful. Push sends only the **delta** (one typed event) per
  mutation, and only to clients that care.

So this work is the transport layer of the **§46 remote epic**. It is **additive**: `/api/poll`
stays as the automatic fallback, so nothing regresses for the single-machine user if the
WebSocket can't connect.

## 93.2 Server event bus (`src/sync/eventBus.ts`)

A small, pure, network-free module — the foundation every other phase consumes. No dependency on
HS-7940; unit-testable in isolation.

**Responsibilities:**

- A monotonic `seq: number` counter, incremented once per emitted event (process-lifetime; not
  persisted — a process restart resets to 0 and clients fall back to a full refetch, §93.6).
- A bounded **ring** of the most recent events (default 1000, ~15 min of typical activity). Old
  events are evicted; a client asking for a `seq` older than the ring's tail gets a
  "too far behind → full refetch" signal (§93.6).
- A registry of connected **sinks** — `(event) => void` callbacks, one per live WebSocket. The bus
  knows nothing about WebSockets; the endpoint (§93.3) registers a sink that serializes + sends.
- `emitEvent(projectSecret, event)` — (a) assigns the next `seq`, (b) appends to that project's
  ring, (c) fans out to every sink subscribed to that project.

**Per-project scoping.** Events are scoped by project secret (today's trust boundary). A sink only
receives events for the project it authenticated to. No cross-project subscription (out of scope,
matches §46).

**Event payloads** (the `type` discriminant + a typed body, validated by a zod schema in
`src/schemas.ts` so both server emit and client reduce share one source of truth):

```
{ seq, type: 'ticket-created',     ticket }
{ seq, type: 'ticket-updated',     id, changes }
{ seq, type: 'ticket-deleted',     id }
{ seq, type: 'note-added',         ticketId, note }
{ seq, type: 'note-deleted',       ticketId, noteId }
{ seq, type: 'category-changed',   ticketIds, to }
{ seq, type: 'priority-changed',   ticketIds, to }
{ seq, type: 'status-changed',     ticketIds, to }
{ seq, type: 'attachment-added',   ticketId, attachment }
{ seq, type: 'attachment-deleted', ticketId, attachmentId }
{ seq, type: 'settings-changed',   key, value }
{ seq, type: 'batch-operation',    op, ids, changes }   // one event for multi-ticket ops
{ seq, type: 'ping' }                                    // heartbeat (not ring-stored)
```

`category-changed` / `priority-changed` / `status-changed` carry `ticketIds: number[]` so a single
field-flip on a multi-selection is one event, not N. `batch-operation` collapses a heterogeneous
bulk mutation into one frame to keep the wire small.

**HS-9043 — server-DERIVED fields must ride along.** A `status` change clears `up_next` and sets the
`completed_at` / `verified_at` / `deleted_at` columns *server-side* (the status-transition block in
`db/tickets.ts::updateTicket`), not in the request body. So the `PATCH /tickets/:id` handler echoes
those derived fields into the `ticket-updated` `changes` (from the resulting row) when `status` is in
the patch, and the client reducer (`wsSync.ts`) clears `up_next` on a `status-changed` to a "done/
parked" status (`shouldResetStatusOnUpNext` — completed/verified/backlog/archive). Without this, a
ticket completed via API/MCP stayed flagged up-next in the UI until the next full poll (the DB itself
was already correct).

**Tests:** `src/sync/eventBus.test.ts` — seq monotonicity, ring eviction at capacity,
`getEventsSince(seq)` returns the tail (and signals "evicted" when `seq` < ring tail), per-project
isolation (a project-A emit reaches only project-A sinks), sink register/unregister.

## 93.3 WebSocket endpoint (`src/routes/wsSync.ts`)

Reuses the **exact transport pattern already in the codebase** for terminal PTYs
(`src/terminals/websocket.ts`): one `ws` `WebSocketServer` in `noServer: true` mode, attached to
the shared `http.Server` via `httpServer.on('upgrade', …)`, wired in `src/server.ts` next to
`wireTerminalWebSocket(httpServer)`.

- **Path:** `GET /ws/sync`. The upgrade handler ignores any `req.url` that doesn't start with
  `/ws/sync` (so it coexists with the terminal handler's `/api/terminal/ws`).
- **Auth:** mirror `authenticate()` in `terminals/websocket.ts` — accept the secret via
  `?project=<secret>`, `X-Hotsheet-Secret` header, **or** `Sec-WebSocket-Protocol:
  hotsheet-secret-<X>` (preferred; doesn't leak into access logs). Resolve via
  `getProjectBySecret`. **Plus** the origin gate from HS-7940 (`isTrustedOrigin`) — this is the
  hard dependency: a non-localhost client must pass both the secret and the trusted-origin check.
- **Catch-up on connect:** `?since=<seq>`. On open, replay `getEventsSince(seq)` from the ring
  before live events flow. If `seq` is older than the ring tail (or absent on a fresh connect),
  send `{ type: 'resync' }` telling the client to do one full HTTP refetch, then stream live.
- **Heartbeat:** server sends `{ type: 'ping' }` every 20s; client replies `{ type: 'pong' }`.
  Either side closes after 2 consecutive missed beats (~40s). Reuses the terminal WS's existing
  ping plumbing as a reference.
- **Lifecycle:** register a bus sink on open; unregister on close/error. Honor the HS-7931
  graceful-shutdown path — `gracefulShutdown` closes the HTTP server, which must not deadlock on
  open sync sockets (§46.10 / §45 cross-ref). Send a close frame to all sync sockets before
  CHECKPOINT.

**Tests:** endpoint auth matrix (good/bad/missing secret; trusted vs untrusted origin once HS-7940
lands), `?since` replay, `resync` on evicted seq, heartbeat timeout closes the socket, sink is
unregistered on close.

## 93.4 Mutation event emission

Every API handler that today calls `notifyMutation()` / `bumpChangeVersion()` **also** calls
`emitEvent(secret, { type, … })` with the typed payload. Today's counter bump
(`src/routes/notify.ts`) stays — it still drives the `/api/poll` fallback and the cheap
`changeVersion` UI ticks. The event emit is **additive alongside** it, not a replacement, until
the fallback is eventually retired.

Emission order: the handler **returns its HTTP response, then emits**, so the originating client
also receives the canonical event after its own mutation completes (one reducer path for local and
remote mutations — the client doesn't special-case "my own write").

Routes to wire (each maps its mutation to the matching event type):

- `src/routes/tickets.ts` — create / update / delete / category / priority / status / batch
- notes (add / delete) — wherever note mutations live in `tickets.ts`
- `src/routes/attachments.ts` — attachment add / delete
- `src/routes/settings.ts` — settings-changed (`key`, `value`)

**Tests:** for each route, assert the emit fires with the right `type` + payload after a mutation;
assert the HTTP response is sent before the emit (ordering).

## 93.5 Client reducer + reconnect + fallback (`src/client/wsSync.ts`)

Replaces the `loadTickets()`-refetch reaction in the poll path with a **per-event reducer** that
mutates in-memory state and re-renders only the affected rows (the existing diff-based render in
`ticketList.tsx` / `ticketsStore.ts` already supports targeted updates).

- **Connect:** open `ws://…/ws/sync` with the secret as a subprotocol; send `?since=<lastSeq>` once
  a prior `lastSeq` exists.
- **Reduce:** validate each frame against the shared zod schema, then dispatch by `type` into
  `ticketsStore` (create/update/delete/note/category/priority/status), settings store, etc. A
  `resync` frame triggers exactly one full `loadTickets()` + settings refetch, then resumes
  streaming.
- **Reconnect:** exponential backoff 1s → 2s → 4s → … capped at 30s. Reply `{ type: 'pong' }` to
  every `ping`; treat 2 missed pings as a dead socket and reconnect.
- **Fallback to `/api/poll`:** if the WebSocket connect fails, or drops **twice within 30s**,
  switch to the existing long-poll path and surface a non-blocking **"live updates unavailable"**
  hint in the UI (small chip; mirrors the existing `serverBusyChip` pattern). Retry the WebSocket
  in the background; on success, drop the hint and stop polling.
- **Single swap point:** the poll loop in `src/client/state.tsx` / `poll.tsx` chooses WebSocket
  when available, poll otherwise. Both feed the **same** store-mutation entry points, so downstream
  consumers (e.g. `claimsStore`, HS-8973) are transport-agnostic.

**Tests:** `src/client/wsSync.test.ts` — each event type mutates the right store; `resync` triggers
one refetch; backoff schedule; pong reply; double-drop flips to poll + shows the hint; reconnect
clears it. **E2E** (`e2e/`): two browser contexts on the same project — a mutation in context A
appears live in context B without a reload; kill the WebSocket and assert the poll fallback keeps
B in sync + shows the hint.

## 93.6 Catch-up, retention, and resync

- Each event has a monotonic `seq`. The client remembers the highest `seq` it has applied.
- On reconnect it sends `?since=<lastSeq>`; the server replays `(lastSeq, current]` from the ring.
- If `lastSeq` is older than the ring tail (client was offline longer than ~1000 events / ~15 min,
  or the server restarted and reset `seq`), the server sends `resync` → the client does **one**
  full HTTP refetch and adopts the server's current `seq`. This bounds memory (ring is fixed-size)
  and guarantees convergence without persisting an event log.

## 93.7 Auth + trust (depends HS-7940)

Carried from §46.5, unchanged here:

- Per-project `X-Hotsheet-Secret` (HTTP) / `?project=` / `Sec-WebSocket-Protocol: hotsheet-secret-…`
  (WebSocket). Subprotocol preferred.
- `isTrustedOrigin(origin)` (HS-7940) gates non-localhost. The `/ws/sync` upgrade MUST honor the
  same origin + secret checks as the HTTP API — this is why HS-7940 is a hard prerequisite for any
  non-local deployment. Locally (the only place this can run before HS-7940) the existing
  secret-only check suffices, matching today's terminal WS.
- Per-client identity (revocable per-device tokens) stays deferred (§46.5 / HS-7946).

## 93.8 Out of scope (tracked elsewhere)

- **Backpressure / event coalescing** under bulk-mutation load (bulk import, demo-mode seed) —
  §46.10.4. A noisy source could flood the socket; the bus should coalesce a burst of rapid
  same-type events into one `batch-operation` above a threshold. Filed as a v2 follow-up (§93.9
  ticket 5) — the core push channel ships without it.
- **Per-client event filtering** — today every client of a project receives every event for that
  project. Server-side filtering by what a client is viewing is a later optimization.
- **Cross-project subscription** — a single socket subscribing to multiple projects. Not needed;
  one socket per project.
- **Multi-client conflict UX** (concurrent-edit toast, `If-Match` optimistic concurrency, plugin
  sync engine audit) — that's **HS-7946** / §46.4, a separate ticket that consumes this channel.

## 93.9 Decomposition (schedulable sub-tickets)

The implementation is broken into independently-schedulable tickets so they can be picked up one at
a time. Dependencies are encoded both in prose and via the `blocked_by` gate.

1. **Server event bus** (`src/sync/eventBus.ts`, §93.2) — foundation. No HS-7940 gate; lands first.
2. **`/ws/sync` endpoint** (`src/routes/wsSync.ts`, §93.3) — upgrade handler, auth (+ HS-7940
   origin gate), heartbeat, `?since` catch-up. **Blocked by** HS-7940 + ticket 1.
3. **Mutation event emission** (§93.4) — wire every mutation route to `emitEvent`. **Blocked by**
   ticket 1.
4. **Client reducer + reconnect + poll fallback** (`src/client/wsSync.ts`, §93.5/§93.6) — the
   client half + the e2e round-trip. **Blocked by** tickets 2 + 3.
5. **Backpressure / coalescing (v2)** (§93.8) — out-of-scope open question, lower priority.
   **Blocked by** ticket 1 (needs the bus).

Downstream consumer: **HS-8973** (live-push the claimed-by chip / `claimsStore` off this bus
instead of its 5s poll) effectively depends on ticket 4 — its store was built with `applyClaims`
as the single swap point exactly so this is a small change.

## 93.10 Cross-references

- §46 — service / client decoupling (the epic this is the transport layer of); §46.3
  synchronization model, §46.5 auth, §46.10 open questions.
- §9 — REST API endpoint reference (the HTTP surface this WebSocket sits beside).
- §22 — terminal drawer (the existing `ws`-in-`noServer`-mode pattern `/ws/sync` reuses).
- §45 — graceful shutdown (open sync sockets must not deadlock `gracefulShutdown`).
- §90 — distributed execution (`blocked_by` gate used to encode the sub-ticket dependencies).

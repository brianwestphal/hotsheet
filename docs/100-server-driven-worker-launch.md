# 100. Server-Driven Worker Launch

**Status: PARTIAL** — the **server-owned terminal lifecycle** (§100.2.2, HS-9077),
the **server reconcile endpoint** (§100.2.1(b), HS-9076), and the **periodic
reconcile interval loop** (§100.2.1(a), HS-9110) **SHIPPED** (2026-06-26/27); only
**client adoption** (§100.2.3, HS-9078) remains. Design HS-9062.

**What shipped (HS-9076):** `reconcilePool(secret, dataDir, repoRoot, deps?)`
(`src/workers/reconcilePool.ts`) — the server analog of the client
`workerPoolPanel.tsx::reconcile`: reap finished/crashed slots (`reapWorker`) →
scale up (`prepareWorker` → `spawnWorkerTerminal` → `registerWorker`) → scale down
(graceful `requestDrain`, newest-first), clamped to `poolMax()`. Exposed as
`POST /api/workers/pool/reconcile` (typed `reconcileWorkerPool`); the
`hotsheet_set_worker_target` MCP tool now calls it after setting the target, so an
AI raising the target with no UI **actually scales the pool**. The pool
**self-heals**: the reconcile captures the owner's intended target up front and
restores it after reaping (since `removeWorker` lowers `targetN` to the slot
count), so a crashed worker is replaced rather than silently dropping the target.
**One open item:** (b) the open UI shows server-spawned tiles **without an
attached terminal view** until the HS-9078 adoption lands.

**What shipped (HS-9110):** the periodic **interval loop** (§100.2.1(a)) —
`startPoolReconcileTimer(dataDir)` (`src/workers/poolReconcileTimer.ts`), mirroring
`leaseSweepTimer.ts` / `telemetryRetentionTimer.ts`: started in `cli.ts`, stopped
in `lifecycle.ts`, off-loop via the §75 scheduler (GC priority, deferred under lag,
coalesced), `unref()`'d. Each ~10 s tick runs `reconcileEnabledHeadlessPools`,
which reconciles a project ONLY when **all three** safety gates hold (§100.3):
(1) the server-readable **headless-pool enable** is set, (2) `targetN > 0` (the
§91.7 empty-pool back-off — an idle pool is skipped, no hammering), and (3) a
worker-capable Claude is connected (`isChannelAlive`). The enable is a new
machine-LOCAL `FileSettings` key `headless_worker_pool`
(`src/workers/headlessPool.ts`, `isHeadlessPoolEnabled`) that the client **Auto
switch also writes** (`workerAutoMode.ts` → `updateSettings`), so turning Auto on
lets the server keep scaling/healing the pool with no window open. `reconcilePool`
still clamps spawns to `poolMax()`.

Closes the gap surfaced by HS-9031:
the worker-pool target (`hotsheet_set_worker_target` / `setPoolTarget`) only
actually **launches** workers while the owner Hot Sheet window is open — launch
is client-driven. So an AI/headless caller that sets the target with no UI open
records the intent but **nothing starts**. Builds on the durable worker pool
([91-worker-pool-scaling.md](91-worker-pool-scaling.md)) and the per-worktree
terminal ([89-git-worktrees.md](89-git-worktrees.md) Phase C).

## 100.0 The gap

Today the reconcile choreography lives in the **client**
(`src/client/workerPoolPanel.tsx`):

- `syncPoolHeadless()` polls `GET /api/workers/pool`, compares the live count to
  the server's `targetN`, and `reconcile()` calls `addOneWorker()` /
  drains the surplus.
- `addOneWorker()` does the actual launch **client-side**:
  `openTerminalRunningCommand(spec.command, spec.label, spec.cwd)` (which spawns a
  PTY via `POST /api/terminal/create` *and* owns the xterm tab in the DOM) →
  `registerPoolWorker({...terminalId})`.

The server already owns the durable bits — `setPoolTarget`
(`POST /api/workers/pool/target`) records `targetN` in the in-memory pool manager
(`src/workers/poolManager.ts`), and `prepareWorker()`
(`src/workers/launchWorker.ts`) creates the worktree server-side. But the **PTY
spawn + slot registration + terminal lifecycle** are bound to an open client.
Result: an MCP tool that raises the target with no window open is a no-op until a
human opens the UI. That defeats AI/headless scaling (the whole point of the
distributed-worker epic) and the Auto worker pool (§91.11).

## 100.1 Goal

Move the **launch choreography server-side** so setting the target actually
scales the pool with **no client open**, while the open-UI client cleanly
**adopts** server-launched workers instead of double-launching.

## 100.2 Design

### 100.2.1 Server reconcile loop (or reconcile endpoint)

A server-owned reconciler that, given the pool's `targetN`, drives the live count
toward it — the server analog of the client `reconcile()`:

- **Scale up:** for each missing slot, `prepareWorker()` (already server-side) to
  create/locate the worktree, then spawn the `claude "/hotsheet-worker"` PTY
  **server-side** through the terminal subsystem (the same `POST
  /api/terminal/create` path that already spawns a PTY — `{ runCommand, cwd,
  spawn:true }`), and `registerPoolWorker({...})` the slot with the
  server-spawned `terminalId`.
- **Scale down:** mark surplus workers `draining` (the existing drain-flag path,
  §91.4) — unchanged; drain is already server-mediated via `onClaimNext`.

Two viable triggers (pick one; lean **(a)** for true headless, with **(b)** as
the manual nudge):
- **(a) A lightweight server interval loop** (reuses the §75 background scheduler)
  that reconciles every ~N s while `targetN > 0` — so a target set headlessly
  takes effect without any client. Gated to only run when there's a connected
  Claude worker-capable context, mirroring the client's channel-visibility gate.
- **(b) A reconcile endpoint** `POST /api/workers/pool/reconcile` the
  `setPoolTarget` path (and the MCP tool) calls after changing the target, so the
  change is applied immediately rather than waiting for the next tick.

### 100.2.2 Server-owned terminal lifecycle

The blocker is that the worker's terminal id is **client-only** today
(`closeDynamicTerminal(w.terminalId)` runs in the browser). For server launch,
cleanup/drain teardown needs a server-side handle to close:

- Give the server-spawned PTY a **server-tracked `terminalId`** with a lifecycle
  the server can close (close PTY + `removeWorktree`) on drain/stop/reap —
  paralleling the client's `closeDynamicTerminal` + the HS-9051 reap path. The
  pool slot stores this id (it already stores `terminalId`).
- A wedged/stale slot is still reaped via the §91.7 liveness path (`lastSeenAt` →
  `dead`); server-side close makes that reap work with no UI.

### 100.2.3 Client adoption (don't double-launch)

When the UI **is** open, it must not re-launch slots the server already started:

- The open client's `syncPoolHeadless`/`reconcile` should **adopt** existing
  server-registered slots — attach an xterm view to the already-spawned PTY
  (by `terminalId`) rather than calling `addOneWorker()` for it. Only genuinely
  missing slots (live count < target AND no server slot) get launched, and that
  launch should also go through the server path so there's one code path.
- **Reconcile the two loops so they don't fight:** the server is the source of
  truth for "which slots exist"; the client renders/attaches and may *request*
  scale changes (stepper) but does not independently spawn. This removes the
  current split-brain where both could add.

## 100.3 Open questions

- **Single owner of reconcile.** Should the client reconciler be fully retired in
  favor of the server loop (client becomes pure view/attach), or kept as a
  fallback when the server loop is disabled? Lean: server is authoritative; client
  attaches + can request, never spawns.
- **Server PTY without a UI.** Confirm the terminal subsystem can hold a spawned
  PTY with no attached xterm indefinitely (buffering/backpressure) — workers are
  long-lived and headless. May need the §54 terminal-checkout/orphan-sink model
  applied server-side.
- **Gating headless launch.** ✅ RESOLVED (HS-9110). A server loop that spawns
  `claude` processes with no human present needs a clear enable signal. Decision:
  a dedicated machine-LOCAL `FileSettings` key `headless_worker_pool` (the explicit
  opt-in) that the §91.11 Auto switch **also writes** — so the existing single
  user-facing switch enables headless scaling, no new UI. The loop additionally
  gates on `targetN > 0` and `isChannelAlive` (a connected worker-capable Claude),
  so it never spawns unexpectedly.
- **Resource/cap safety.** `poolMax()` (CPU-cores−2, capped 8) still bounds N;
  confirm the server loop honors it and the §91.7 empty-pool/back-off behavior.

## 100.4 Tests

- Unit: server reconcile raises/lowers the live slot set toward `targetN`
  (prepare + spawn + register on up; drain on down), honoring `poolMax()`.
- Integration: set the target via the MCP tool / endpoint with **no client**, and
  assert worktrees + PTYs are created and slots registered server-side; drain
  tears them down (PTY closed + `removeWorktree`).
- Adoption: with a slot already server-registered, the client attaches (no second
  PTY spawned) — guards the double-launch regression.
- Lifecycle/reap: a server-spawned slot gone silent past `STALE_AFTER_MS` is
  reaped server-side with no UI.

## 100.5 Follow-up tickets

- **Server reconcile loop / endpoint** (§100.2.1) — the core. ✅ SHIPPED (HS-9076):
  the `reconcilePool` core + `POST /api/workers/pool/reconcile` + the
  `hotsheet_set_worker_target` MCP-tool trigger (the no-UI scaling path). The
  periodic **interval loop** (§100.2.1(a)) ✅ SHIPPED (HS-9110):
  `src/workers/poolReconcileTimer.ts` + the `headless_worker_pool` enable
  (`src/workers/headlessPool.ts`), gated on enable + `targetN > 0` + `isChannelAlive`.
- **Server-owned terminal lifecycle** for pool workers (§100.2.2) — server-side
  close/reap of the worker PTY (couples with the HS-9051 reap path). ✅ SHIPPED
  (HS-9077): `src/workers/serverWorkerLifecycle.ts` — `spawnWorkerTerminal(secret,
  dataDir, spec)` spawns the worker PTY server-side (returns a server-tracked
  `terminalId`) and `reapWorker(secret, dataDir, repoRoot, slot, git?)` does the
  no-UI teardown (force-release claims → close PTY → `removeWorktree` → drop slot),
  reusing the extracted `createDynamicTerminal` / `destroyDynamicTerminal` server
  services. Confirmed an unattached PTY buffers in the session RingBuffer (§54), so
  a headless worker terminal is safe.
- **Client adoption** of server-launched workers (§100.2.3) — attach-don't-spawn,
  retire the client's independent launch. — **HS-9078** (pending).
- Relates: HS-9031 (investigation), §91.11 Auto switch, §75 background scheduler,
  HS-9051 (reap path).

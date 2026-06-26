# 103. Custom Command Buttons: Opt-In Target Picker (Main / Worker / All)

**Status: DESIGN ONLY** (HS-9059, 2026-06-26). From the HS-9040 design
investigation. A custom Claude command button today always triggers the **main**
Claude (the FIFO-leader channel server). With workers running — each its own
channel server in a worktree — that's the right **default**, but the owner
sometimes wants to **fan a command out** or **target a specific worker**. This
adds an opt-in target picker without changing the default click. Relates to
[92-coordinator-dispatch.md](92-coordinator-dispatch.md), §83 (long-press
secondary action), and HS-9036 (per-server addressing).

## 103.0 Today

A custom command button calls `triggerChannelAndMarkBusy(cmd.prompt)` →
`triggerChannel` (`src/client/commandSidebar.tsx` / `channelUI.tsx`), which routes
to the **main** agent (the oldest **main** channel connection — `pickLeader`
prefers it, never a worker; §89.2/HS-9038). Single-click = main is correct for the
single-user / no-workers case and must stay the default.

## 103.1 Proposal

Keep **default click = main** (single-user / no-workers experience unchanged). Add
an **opt-in target picker** on a command button — a **long-press or small chevron
menu** (mirrors the §83 long-press secondary action + the §92 "Dispatch to
worker" pattern):

> **Run on → Main · worker-1 · worker-2 · … · All workers**

- **Main** (default) — current behavior.
- **worker-N** — route the trigger to **that worker's** channel server. Each
  worker registers its own channel server under the owner data dir; addressing a
  specific worker's server is the HS-9036 per-server-addressing work this depends
  on (route by the worker's channel port / server key).
- **All workers** — fan the **same prompt** out to **every live worker's** channel
  server. Useful for cross-worktree maintenance: a `git pull`/rebase, `npm ci`
  after a dep change, a lint/format sweep — run once per worktree.

## 103.2 The autonomy caution

A worker runs an autonomous claim/lease loop (`/hotsheet-worker`). **Commanding it
mid-ticket interleaves with its work** — the injected prompt lands in the same
Claude session that's mid-claim, which can corrupt the loop or the ticket. So:

- **Scope worker-targeting to idempotent / maintenance commands**, or **warn**
  before sending to a busy worker (the worker's pool slot state — `working` vs
  `idle`, §91.2 — is already known; gate or warn on `working`).
- A safer variant for non-idempotent work is **dispatch** (§92) — assign a ticket,
  let the worker pick it up at its own loop boundary — rather than injecting a
  prompt mid-loop. The target picker is for *commands* (maintenance/fan-out); the
  dispatch path is for *work*.
- Consider tagging a command as "worker-safe" (maintenance) in its definition, and
  only offering worker/all-workers targets for those — keeps a destructive
  one-off from being fanned out by accident.

## 103.3 Surface / mechanics

- **Trigger UI:** reuse the §83 long-press infrastructure on the command button
  (it already distinguishes a click from a long-press for the secondary action),
  plus a small chevron for discoverability. The menu lists Main + the live workers
  (from the pool state) + All workers.
- **Routing:** `triggerChannel` gains an optional **target** (server key / port).
  Main = today's leader pick; a worker = its registered channel server; All =
  iterate live worker servers and trigger each. Depends on HS-9036 addressing a
  specific worker's channel server by id/port.
- **Busy gating:** when a target worker is `working`, warn (confirm dialog) or
  disable, per §103.2.

## 103.4 Open questions

- **"Worker-safe" command flag** vs. always-warn-on-busy — lean toward a flag for
  the fan-out commands (maintenance) + a warn fallback for everything else.
- **All-workers semantics** — fire-and-forget vs. collect per-worker results.
  Lean fire-and-forget for v1 (maintenance commands), with the per-worker outcome
  visible in each worker's terminal/commands-log.
- **Dependence on HS-9036** — specific-worker + all-workers both need per-server
  addressing; if HS-9036 isn't ready, ship **Main-only + All-workers** (broadcast
  doesn't need to address one) or gate the whole picker on it.
- Whether the picker also appears in the command-group long-press / the §92
  dispatch menu, to avoid two parallel "send to worker" affordances.

## 103.5 Tests

- Unit: `triggerChannel` routes to the selected target (main leader / a worker's
  server / all live workers); busy-worker warn gate.
- Unit/e2e: long-press / chevron opens the target menu populated from the live
  pool; default click still hits main (regression guard).
- e2e: "All workers" triggers each live worker's server once.
- Manual-test-plan: the real fan-out across live worker terminals.

## 103.6 Follow-up tickets

- **Target picker UI** (long-press/chevron menu: Main / worker-N / All) on the
  command button (§103.3).
- **`triggerChannel` target routing** (main / specific worker server / broadcast)
  — depends on HS-9036 per-server addressing.
- **Busy-worker warn gate** + optional "worker-safe" command flag (§103.2).
- Relates: HS-9040 (investigation), §83 long-press, §92 dispatch, HS-9036.

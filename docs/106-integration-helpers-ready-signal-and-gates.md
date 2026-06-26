# 106. Integration Helpers: Explicit "Branch Ready" Signal + Optional Gate-Running

**Status: PARTIAL** — §106.2 (optional in-helper gate-running) **SHIPPED (HS-9091,
2026-06-26)**; §106.1 (explicit "branch ready" signal) still design only (HS-9090).
Smaller follow-up to HS-9048, which shipped the deterministic git integration core
(`src/workers/integrate.ts`: `detectTargetBranch` / `listReadyBranches` /
`integrateBranch` + `GET /api/workers/integratable` + `POST /api/workers/integrate`,
wired into the owner skill at `SKILL_VERSION` 17 —
[89-git-worktrees.md](89-git-worktrees.md) §89.7). Two enhancements, both hardening;
the core integration flow works without them.

## 106.0 Context — the periodic merge+test loop

From the worker-cadence discussion: the owner runs a periodic
**integrate-ready-branches** loop. Today it **scans** (`listReadyBranches`
enumerates `hotsheet/*` ahead of the target on a timer). The two enhancements make
that loop **event-driven and complete**:

- the **explicit "branch ready" signal** (item 1) becomes the loop's **trigger**,
- the **optional in-helper gate-running** (item 2) makes each integrate a
  one-shot merge+verify.

## 106.1 Item 1 — Explicit "branch ready" signal

Today the owner discovers integratable work by enumerating `hotsheet/*` branches
ahead of the target. A lighter, **explicit** per-worker signal — set when a worker
**finishes + has committed + rebased** (the §99 refresh routine, at a batch
boundary) — is more deterministic than scanning.

- **Semantics:** the signal fires **once per batch boundary**, not per ticket
  (per [98-worker-batching-policy.md](98-worker-batching-policy.md) — a ready
  branch may carry several tickets). It means "this branch is committed, rebased
  onto the latest target, and ready to merge."
- **Where it rides:** the pool slot state (`src/workers/poolManager.ts`) gains a
  `ready` / `readyBranch` marker, set by the worker (via a small flag/endpoint or
  the existing renew/claim channel) when it hands off, OR a tiny dedicated
  endpoint `POST /api/workers/ready { branch }`. Lean: ride the pool slot so the
  panel already has it.
- **Surfacing:** the worker-pool panel shows **"N branches ready to integrate"**
  (and which workers), so the owner sees the queue at a glance — and the owner's
  periodic loop integrates **on the signal** rather than scanning on a timer.
- **Fallback stays:** `listReadyBranches` remains the source of truth / reconcile
  (a worker that died after committing but before signaling is still discovered by
  the scan). The signal is an optimization + UX, not a replacement.

### Relationship to the cadence trio

- **§99 (HS-9063)** — the refresh routine; a successful refresh + commit at a
  batch boundary is what *sets* this signal.
- **§98 (HS-9064)** — batching; the signal fires once per batch, matching the
  integrate granularity.
- **This signal (HS-9053)** — the event the owner's integrate loop keys on.

So prioritize this if the owner's periodic merge cadence should be **reliable
(event-driven)** rather than **scan-on-a-timer**.

## 106.2 Item 2 — Optional in-helper gate-running — **SHIPPED (HS-9091)**

**What shipped:** `integrateBranch(repoRoot, branch, target, git?, { gate? })` takes
an optional `gate: { command, timeoutMs?, run? }`. After a successful `--no-ff`
merge it runs the command via `defaultGateRunner` (platform shell, combined
stdout+stderr tail-capped to 256 KB, POSIX process-group kill on timeout so an
`npm`-spawned `tsc` is reaped too). Pass → `merged` with a `gate` summary; fail →
**`gate-failed`**; timeout (default `DEFAULT_GATE_TIMEOUT_MS` = 15 min, overridable)
→ **`gate-timeout`** — both **reset the target back to the captured pre-merge HEAD**
so it's left clean. `IntegrateResult` gained `gate?: { ran, passed, output,
timedOut }`; `IntegrateStatus` gained `gate-failed` / `gate-timeout`
(mirrored in `IntegrateResultSchema`, `src/api/workers.ts`). The runner is
injectable for tests. The command source is the **`integrationGate`** project
setting (`POST /api/workers/integrate` reads it via `readFileSettings`; absent/blank
→ the agent-runs-gates default). §95-classified **SHARED** (a project build contract
— falls through `defaultLayerForKey` to the committed `settings.json`). Tests:
`src/workers/integrate.test.ts` (real temp repo: pass→merged, fail→rollback+clean,
hang→timeout+rollback, injected-runner, no-gate-unchanged). Original design:

`integrateBranch` currently does **git only** and leaves running the project gates
(tsc / lint / tests) to the agent. An **optional** mode runs a configured gate
command after the merge and reports pass/fail, **rolling back on failure**:

- **Opt-in + project-configurable** — gate commands differ per project (a
  `integrationGate` / `gateCommand` setting, e.g. `npm run -s typecheck && npm run
  -s lint && npm test`). Off by default; the agent-runs-gates flow (today) stays
  the default.
- **Roll back on failure** — if the gate fails, **revert the merge** (the merge
  was `--no-ff`, so revert/reset the merge commit) and return a structured
  `gate-failed` result with the gate output, leaving the target clean — same
  "leave it clean, hand judgment to the agent" contract as the conflict path.
- **Time-bounded** — a misconfigured/hanging gate must not wedge the integrate;
  enforce a timeout → `gate-timeout`, rolled back.
- **Result shape** — extend `IntegrateResult` with `gate?: { ran, passed,
  output, timedOut }` so a caller knows whether gates ran and the outcome.

This makes the helper a more complete one-shot ("merge + verify or roll back")
for the headless/automated path, while keeping the agent-judgment default for
interactive use.

## 106.3 Open questions

- **Signal transport** — pool-slot marker vs. dedicated endpoint vs. a note/flag
  on the ticket. Lean pool-slot (panel already polls it); confirm it survives a
  worker reconnect.
- **Gate command source** — a single `integrationGate` setting vs. reusing a
  project "gates" config that the §53/CI work might also want. Classify per §95
  (shared, since it's a project build contract).
- **Rollback safety** — confirm reverting a `--no-ff` merge on the target is clean
  when the owner's tree is otherwise untouched (it should be — `integrateBranch`
  already guards clean + on-target before merging).
- **Interaction with batching** — a gate-failed batch branch blocks all its
  tickets; the owner decides whether to ask the worker to split/fix (ties to the
  §98 isolate-risky default).

## 106.4 Tests

- Unit (signal): a worker hand-off sets the pool-slot `ready` marker; the panel
  count reflects it; `listReadyBranches` still finds an unsignaled-but-ahead
  branch (fallback).
- Unit (gates, real temp repo): `integrateBranch` with gates configured runs the
  command after merge → `merged` on pass; **rolls back** + `gate-failed` on a
  failing command, leaving the target clean; `gate-timeout` on a hanging command.
- Integration: the owner loop integrates on the signal (event-driven) and the scan
  still catches a missed branch.

## 106.5 Follow-up tickets

- **Explicit "branch ready" signal** — pool-slot marker + worker set + panel "N
  ready to integrate" + owner loop keys on it (fallback scan kept) (§106.1).
- **Optional in-helper gate-running** — opt-in, project-configurable gate command,
  rollback-on-failure, time-bounded, `IntegrateResult.gate` (§106.2).
- Relates: HS-9048 (`integrate.ts` core), HS-9063/§99 (sets the signal),
  HS-9064/§98 (batch granularity), §95 (gate-command classification).

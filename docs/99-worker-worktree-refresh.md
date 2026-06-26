# 99. Worker-Side Worktree-Refresh Routine

**Status: PARTIAL** — the **`refreshWorktree` helper** (§99.2, the core)
**SHIPPED** (HS-9074, 2026-06-26); the optional endpoint is HS-9075 and the
`/hotsheet-worker` skill prose is HS-9072. Design HS-9063. The **worker-side**
"stay fresh" half of the integration story — the deterministic counterpart to the
owner-side `src/workers/integrate.ts` (HS-9048,
[89-git-worktrees.md](89-git-worktrees.md) §89.7). Pulses once per **batch
boundary** as defined by [98-worker-batching-policy.md](98-worker-batching-policy.md)
(HS-9064). Shares the `node_modules` provisioning path with
[105-worktree-node-modules-provisioning.md](105-worktree-node-modules-provisioning.md)
(HS-9057).

## 99.0 Goal

Make "a worker stays current with the target" **deterministic tooling**, not
skill prose. HS-9044 baked "rebase onto the latest target before/while working"
into `/hotsheet-worker`, but nothing enforces it: agents do it inconsistently,
and "while working" risks rebasing a **dirty tree mid-ticket** (conflicts, lost
edits). This is the same prose→tooling move HS-9048 made for owner-side
integration — a small, injectable, well-tested helper the worker calls at a safe
boundary.

The key correctness coupling this closes: **a rebase that pulls dependency
changes leaves `node_modules` stale**, so the gates (tsc / lint / tests) would
run against the WRONG deps — silently green-but-wrong. The refresh routine ties
the rebase and the conditional reinstall together so they can't drift apart.

## 99.1 When it runs: the loop boundary, never mid-ticket

The worker calls `refreshWorktree` at the **top of a claim iteration, when the
tree is clean** — i.e. at the batch boundary (§98), between committed units of
work — **not** "before/while working" on a ticket. The clean-tree guard makes the
unsafe timing impossible: if the tree is dirty (work in progress), the routine
refuses rather than rebasing over uncommitted edits.

This mirrors the owner-side `integrateBranch` guard, which refuses unless the
owner worktree is clean and on the target.

## 99.2 The `refreshWorktree` helper

Build it as a sibling to `src/workers/integrate.ts`, reusing the same injectable
`GitRunner` (`defaultGit` / `type GitRunner` from `src/worktrees.ts`) and the
same structured-result shape (`{ ok, status, ... }`, mirroring `IntegrateResult`)
so it's unit-testable against a real temp repo with no mocking of git.

Signature (sketch):

```ts
export type RefreshStatus =
  | 'refreshed'        // rebased (or already up to date); deps reconciled if needed
  | 'dirty-tree'       // refused: uncommitted changes present
  | 'conflict'         // rebase hit a non-trivial conflict; aborted cleanly
  | 'error';

export interface RefreshResult {
  ok: boolean;
  status: RefreshStatus;
  rebased: boolean;        // did the rebase move HEAD?
  reinstalled: boolean;    // did we run `npm ci` (lock/package.json changed)?
  clearedArtifacts: boolean;
  conflicts?: string[];    // when status === 'conflict'
  detail?: string;
}

export async function refreshWorktree(
  worktreeRoot: string,
  opts?: { clearArtifacts?: boolean },
  git: GitRunner = defaultGit,
): Promise<RefreshResult>;
```

### Steps

1. **Clean-tree guard.** `git status --porcelain`; if non-empty →
   `{ ok:false, status:'dirty-tree' }`. The safe rebase point is between
   tickets/batches when work is committed (identical guard to `integrate.ts`).
2. **Fetch + rebase onto the target.** Reuse `detectTargetBranch(worktreeRoot)`
   (already exported from `integrate.ts`). `git fetch` (when the repo has a
   remote), then `git rebase <target>`.
   - Trivial/clean rebase → continue.
   - **Non-trivial conflict → `git rebase --abort`** (clean rollback), capture
     the conflicted files, return `{ ok:false, status:'conflict', conflicts }`.
     **Judgment stays with the agent** (per the HS-9044/9048 boundary): the agent
     resolves sensibly or leaves a `FEEDBACK NEEDED:` note. The helper never
     force-resolves.
3. **Conditional dependency refresh — the key coupling.** If the rebase changed
   `package-lock.json` (or `package.json`), run the provisioning path's reconcile
   (`npm ci`); otherwise **skip**. This reuses the SAME helper as HS-9057's
   worktree-create provisioning (CoW clone → symlink → `npm ci`, incl. the
   lock-diff reconcile guard) so create + refresh share one routine and the
   install logic isn't duplicated (HS-9057's note pins this).
4. **Optional stale-artifact clear.** When `opts.clearArtifacts` (agent
   judgment), drop `dist/` / `*.tsbuildinfo` (+ any project-configured cache) that
   would be stale post-rebase. Cheap + opt-in; the agent decides when it's worth
   it (e.g. after a rebase that touched build inputs).

The helper does **deterministic git + install only** — no gate-running, no
conflict resolution, no pushing. Same division of labor as `integrate.ts`.

## 99.3 Surface

- **Helper** (`src/workers/refreshWorktree.ts`) — the unit above.
- **Optional endpoint / MCP tool** so it's callable headless, paralleling
  `POST /api/workers/integrate`: e.g. `POST /api/workers/refresh`
  `{ worktree?, clearArtifacts? }` → the `RefreshResult`. A worker terminal can
  call it directly; a headless/server-driven worker (HS-9062) can call it without
  a UI. Add a typed caller in `src/api/workers.ts` if exposed.
- **`/hotsheet-worker` skill** (`src/skills.ts`, `workerSkillBody`,
  `SKILL_VERSION` bump): replace the ad-hoc "rebase before/while working"
  instruction with "call the refresh routine at the loop boundary (clean tree),
  once per batch (§98); on `conflict`, resolve or `FEEDBACK NEEDED:`; on
  `dirty-tree`, commit first." This same `SKILL_VERSION` bump is shared with the
  HS-9064 batching prose.

## 99.4 Relationship to the cadence story

- **This doc (HS-9063)** = the deterministic refresh *pulse*.
- **[§98](98-worker-batching-policy.md) (HS-9064)** = how many tickets between
  pulses (the aggressiveness knob); a batch groups around this routine.
- **HS-9053** = the explicit "branch ready" signal the owner integrates on — set
  after a successful refresh + commit at a batch boundary.
- **HS-9048 `integrate.ts`** = the owner-side mirror this is modeled on.
- **[§105](105-worktree-node-modules-provisioning.md) (HS-9057)** = the shared
  provisioning/reconcile helper step 3 calls.

## 99.5 Tests

Real temp-repo tests (mirror `worktrees.test.ts` / `integrate.test.ts`):

- **Clean-tree guard** — dirty worktree → `dirty-tree`, no rebase attempted.
- **Rebase fast-forward / clean** — target moved ahead → `refreshed`,
  `rebased:true`.
- **Already up to date** — no-op → `refreshed`, `rebased:false`.
- **Conflict-abort** — a conflicting target change → `conflict` with the
  conflicted files captured, tree left clean (rebase aborted, not mid-rebase).
- **Lock-change → reinstall vs no-change → skip** — a rebase that changes
  `package-lock.json` triggers the reconcile (`reinstalled:true`); one that
  doesn't skips it (`reinstalled:false`).
- **Artifact clear** — `clearArtifacts:true` removes `dist/`/`*.tsbuildinfo`;
  default leaves them.

## 99.6 Open questions

- Whether to ship the endpoint/MCP tool now or only the helper + skill prose
  (lean: helper + prose first; add the endpoint when HS-9062's server-driven
  workers need it headless).
- The exact set of project-configurable cache paths for step 4 (start with
  `dist/` + `*.tsbuildinfo`; generalize via the HS-9057 worktree-setup hook
  config if needed).

## 99.7 Follow-up tickets

- **`refreshWorktree` helper + tests** (the core of this doc). ✅ SHIPPED (HS-9074).
  `src/workers/refreshWorktree.ts`: clean-tree guard → `detectTargetBranch` + fetch
  (when a remote exists) + `git rebase <target>` (conflict → capture files + `rebase
  --abort` → `conflict`) → conditional reinstall (only when the rebase changed
  `package-lock.json`/`package.json`, detected via `git diff preHead postHead`),
  reusing `provisionNodeModules` with a new `forceReconcile` option (HS-9074) →
  optional `dist/`/`*.tsbuildinfo` clear. Injectable `GitRunner` + reinstall runner;
  7 real-temp-repo tests (§99.5). Deterministic git + install only — no gates, no
  conflict resolution, no push.
- **Shared provisioning/reconcile helper** — factor HS-9057's CoW→symlink→`npm
  ci` (incl. lock-diff reconcile) so both worktree-create and this refresh call
  it (tracked on HS-9057; this doc consumes it).
- **`/hotsheet-worker` skill prose** to call the routine at the loop boundary
  (shares the `SKILL_VERSION` bump with HS-9064's batching prose, HS-9072).
- **(Optional) `POST /api/workers/refresh` endpoint + typed caller** for headless
  workers (HS-9062).

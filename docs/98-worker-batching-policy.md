# 98. Worker Batching Policy

**Status: PARTIAL** — the **skill prose** (§98.4 items 1+2) **SHIPPED**
(HS-9072, 2026-06-26, `SKILL_VERSION` → 19); the **partitioner grouping
heuristic** (§98.4 item 3) is HS-9073 (pending). Design HS-9064. The "how
aggressive should rebasing be" knob for the distributed-worker epic. Mostly
**skill prose + a dispatch/partition heuristic**, not heavy tooling.

**What shipped (HS-9072):** the `/hotsheet-worker` skill (`workerSkillBody`) now
describes the **batch-then-pulse** cadence — keep claiming small/related tickets
onto one branch, isolate large/risky onto their own, and run the §99
`refreshWorktree` rebase + the gates **once at the batch boundary** (clean tree,
between committed units), then signal `POST /api/workers/ready` once per batch.
The `/hotsheet` owner skill (`mainSkillBody`) notes a ready branch may carry a
**batch** of several tickets (one `integrateBranch` + one gate run; clear
`pending_integration` for every ticket it carried). Skill-body presence
assertions guard the prose. Sits between
[99-worker-worktree-refresh.md](99-worker-worktree-refresh.md) (HS-9063 — the
deterministic refresh *pulse* a batch groups around) and the prompt-based /
coordinator-dispatch partition path
([101-prompt-based-worker-management.md](101-prompt-based-worker-management.md),
HS-9061; [92-coordinator-dispatch.md](92-coordinator-dispatch.md)). Owner-as-
integrator workflow it amends: [89-git-worktrees.md](89-git-worktrees.md) §89.7.

## 98.0 Goal

Stop paying the fixed per-ticket overhead of `rebase` + conditional `npm ci` +
a full gate run (tsc / lint / tests) for **every** small ticket. When several
small, related tickets are in flight, a worker should be able to do them on
**one branch** and pay that overhead **once, at the batch boundary** — while
large or risky tickets still get their own isolated branch.

The fixed cost per "freshness pulse" (the §99 `refreshWorktree` routine: clean-
tree → fetch → rebase → conditional reinstall → optional cache clear, then the
gates) is real and roughly constant regardless of ticket size. Amortizing it
across a coherent batch is the single biggest lever on throughput when the Up
Next pool is a long tail of small tickets.

## 98.1 The policy

### 98.1.1 Worker side — batch, then pulse at the boundary

A worker MAY claim and work several **small, related** tickets on ONE branch
before it commits, runs the gates, and rebases. Concretely:

- Claim ticket → work it → commit (scoped) on the worker branch.
- If the next claimable ticket is **small and related** (see §98.2) and the
  current batch is still under the size/risk ceiling, claim it onto the **same**
  branch and keep going — do **not** rebase or run the full gate suite yet.
- At the **batch boundary** — when the next ticket is large/unrelated, when the
  pool drains, or when the batch hits its ceiling — run the §99 `refreshWorktree`
  pulse once (clean tree → rebase → conditional reinstall), run the gates once
  over the accumulated work, then hand off the branch for integration (set
  `pending_integration` per §89.7 / HS-9045).

The batch boundary is exactly the point the §99 routine is designed to pulse on
(it requires a **clean tree**, so it only fires between committed units of work,
never mid-ticket). Batching is therefore "how many committed tickets accumulate
between two refresh pulses."

### 98.1.2 Owner / dispatch side — group into a worker's queue

When the owner partitions or dispatches work (the HS-9061 prompt-based splitter,
the §92 coordinator-dispatch drag, or the AI-partition path), it should group
small or related tickets into **one worker's queue** rather than enforcing strict
one-ticket-per-worker. The same merge/test/rebase overhead is then amortized on
the owner's integration side too: one ready branch carrying a coherent batch is
one `integrateBranch` call + one gate run, instead of N.

The grouping decision is the AI's, driven by the signals in §98.2 and gated by
the flat `blocked_by` graph (never group a ticket with one of its own
dependencies into the same in-flight unit — the dependency must integrate first;
see [90-distributed-execution.md](90-distributed-execution.md) §90.6).

## 98.2 Grouping signals (what makes a good batch)

The AI chooses batches from:

- **Size** — small tickets (quick edits, doc fixes, one-file changes) batch;
  large or open-ended tickets get their own branch.
- **Relatedness** — shared files/area, shared tags or category, sibling tickets
  surfaced from the same investigation. Related work touches overlapping code, so
  doing it together both amortizes overhead AND shrinks the per-batch conflict
  surface (the changes are already coherent).
- **`blocked_by` lineage** — tickets in the same dependency chain must serialize;
  independent clusters parallelize. A batch must be internally consistent with
  the gate (no intra-batch unmet dependency).
- **Risk** — a ticket flagged risky (touches a hot/shared module, large diff,
  migration) is **isolated** onto its own branch so a failure or a nasty conflict
  is contained to that one unit.

## 98.3 The tradeoff this encodes (the open question)

> Bigger batches = less overhead but more **drift** (the branch falls further
> behind the target between rebases) + a **larger conflict surface** at
> integration. Smaller batches = fresher + smaller conflicts but more churn
> (more rebases / installs / gate runs) across N workers.

**Default: batch small/related tickets together; isolate large or risky ones onto
their own branch.** This biases toward amortization for the common long-tail case
while keeping the blast radius of any single risky change small.

Tunable levers (start with sensible defaults, expose later only if needed):
- A soft **batch ceiling** — max tickets and/or max accumulated diff size before
  a forced boundary, so a batch can't drift unbounded.
- A **relatedness threshold** — how strong the shared-files/tag signal must be to
  co-batch vs. split.

These are AI-judgment defaults in the skill prose for v1, not configuration.

## 98.4 Shape / where it lands

This is **prose + heuristic**, deliberately not new tooling:

1. **`/hotsheet-worker` skill** (`src/skills.ts`, `workerSkillBody`) — describe
   the batch-then-pulse cadence: keep claiming small related tickets onto the
   current branch; rebase + run gates at the batch boundary (via the §99 refresh
   routine), not per ticket; isolate large/risky tickets. Bump `SKILL_VERSION`.
2. **`/hotsheet` (owner) skill** (`mainSkillBody`) — note that workers hand off
   **batches**, so the owner integrates one ready branch per batch (the §89.7
   `listReadyBranches` → `integrateBranch` loop already iterates branches; this
   just sets the expectation that a branch may carry several tickets). The
   explicit "branch ready" signal (HS-9053) fires once per **batch** boundary,
   not per ticket. Same `SKILL_VERSION` bump.
3. **Partition / AI-partition path** (HS-9061; `src/workers/partition.ts`,
   `suggestN.ts`) — prefer coherent grouping: when splitting the Up Next set
   across N workers, cluster by the §98.2 signals so each worker's chunk is a
   coherent batch, rather than round-robin by index.
4. **(Optional) batch hints** — surface a lightweight relatedness/size hint the
   partitioner consumes (e.g. reuse the existing tag/category signals plus a
   cheap shared-file heuristic from ticket text). Only if §98.2's existing
   signals prove insufficient in practice.

No schema change and no new endpoint are required for v1 — batching is a behavior
encoded in the worker loop's claim decisions and the partitioner's clustering.

## 98.5 Interaction with the refresh pulse (HS-9063) and the ready signal (HS-9053)

The three form one cadence story:

- **§99 / HS-9063** defines the deterministic refresh *pulse* (clean-tree guard →
  rebase → conditional reinstall → optional cache clear). It is the unit a batch
  groups around — it fires **once per batch boundary**.
- **This doc (HS-9064)** decides **how many tickets** sit between two pulses
  (the aggressiveness knob).
- **HS-9053** (the explicit "branch ready" signal) is the event the owner's
  periodic integrate loop keys on; it too fires **once per batch**, so the owner
  integrates a coherent unit deterministically instead of scanning `hotsheet/*`
  on a timer.

## 98.6 Tests

- Unit (partition clustering): the partitioner groups small/related tickets into
  the same chunk and isolates a large/risky ticket; never co-batches a ticket
  with one of its `blocked_by` dependencies.
- Skill-prose presence: the `/hotsheet-worker` + `/hotsheet` bodies describe the
  batch-boundary cadence (guards against silent regressions on the
  `SKILL_VERSION` bump, like the existing skill body assertions).
- The mechanical refresh-at-boundary behavior is covered by §99's tests; this doc
  adds only the grouping/clustering coverage.

## 98.7 Open questions

- The concrete batch ceiling (ticket count vs. cumulative diff size) — start with
  an AI-judgment default, measure, then consider a number.
- Whether to expose any of the levers (§98.3) as a per-project setting, or keep
  them purely AI-judgment. Lean: keep implicit for v1.
- Whether the relatedness heuristic needs the file-overlap hint (§98.4 item 4) or
  the existing tag/category/`blocked_by` signals suffice.

## 98.8 Follow-up tickets

- **Skill-prose update** (`/hotsheet-worker` + `/hotsheet`, `SKILL_VERSION` bump)
  describing the batch-then-pulse cadence — depends on HS-9063's refresh routine
  existing so the prose can point at it. ✅ SHIPPED (HS-9072).
- **Partitioner grouping heuristic** — make `partition.ts` / the AI-partition
  path cluster by the §98.2 signals (depends on HS-9061). — **HS-9073** (pending).
- **(Optional) batch-hint surfacing** for the partitioner, only if §98.2 proves
  insufficient.

# 101. Prompt-Based Worker / Work-Splitting Management

**Status: PARTIAL** — the core **prompt box + channel-trigger wrapper** (§101.1-101.2)
**SHIPPED** (HS-9079, 2026-06-26); the "Parallelize tag…" quick action + the
plan-preview wiring to the partition editor are HS-9080 (pending, also wants the
HS-9073 coherent partitioner for good default chunks). Design HS-9061. The second
half of HS-9031 — the MCP worker tools (`hotsheet_get_worker_pool` /
`hotsheet_set_worker_target` / `hotsheet_dispatch_tickets` / `hotsheet_drain_workers`)
already shipped; this is the **prompt-driven** owner-facing manager that drives them.

**What shipped (HS-9079):** a prompt text box + "Go" in the worker-pool panel
(`workerPoolPanel.tsx`). `buildWorkerManagementPrompt(instruction)` wraps the
owner's natural-language request in a worker-management directive (query → size →
partition → dispatch via the `hotsheet_*` tools; "manage, don't do the work
yourself"); `submitWorkerPrompt` routes it through `triggerChannelAndMarkBusy` to
the **main** FIFO-leader agent (the unchanged default target of `triggerChannel`,
HS-9084), gated on the channel being connected and **busy-aware** (a `confirmDialog`
before stacking onto a mid-task agent, §101.4). The agent does the actual
orchestration at runtime with the MCP tools. Builds on the worker
pool ([91-worker-pool-scaling.md](91-worker-pool-scaling.md)), coordinator
dispatch ([92-coordinator-dispatch.md](92-coordinator-dispatch.md)), and the
batching policy ([98-worker-batching-policy.md](98-worker-batching-policy.md)).

## 101.0 Goal

Give the owner a **text box** — in the worker-pool panel — where they type a
natural-language instruction like *"parallelize all tickets tagged 'hello'"* and
Hot Sheet drives Claude (via the channel) to carry it out: query the matching
tickets, size the pool, partition the work into coherent chunks, and dispatch
those chunks across workers. The manual stepper + per-tile dispatch stay; this is
the high-level "just tell it what you want" path.

## 101.1 How it works

The prompt is **routed through the channel trigger to the main agent** with a
worker-management instruction wrapper, leveraging the shipped MCP tools — no new
orchestration engine:

1. **Owner types a prompt** in the pool panel (e.g. *"split the backlog tagged
   `refactor` across 3 workers"*, *"parallelize everything in Up Next that's
   independent"*).
2. **Hot Sheet wraps + triggers the channel** (like a custom command button,
   §83/§59 trigger path) with a system-ish instruction: "You are managing the
   worker pool. The owner asked: «prompt». Use the `hotsheet_*` worker tools to
   query matching tickets, size the pool, partition, and dispatch."
3. **The main agent executes** with the MCP tools:
   - `hotsheet_query_tickets` — resolve the set the prompt names (tag / category /
     status / free-text criteria).
   - `hotsheet_set_worker_target` — size the pool (informed by the §91.6
     suggest-N heuristic).
   - **partition** — group into coherent batches per the §98 batching signals
     (size / relatedness / `blocked_by`), reusing `src/workers/partition.ts`.
   - `hotsheet_dispatch_tickets` — assign each chunk to a specific worker
     (claim-by-id on the worker's behalf, §92).
4. **The plan is shown before/while executing** — reuse the HS-8965/8977
   **partition editor UI** (which tickets → which worker) so the owner can
   review/adjust before dispatch, not just watch after the fact.

## 101.2 Surface

- A **prompt text box** in the worker-pool panel (`src/client/workerPoolPanel.tsx`)
  — a single input + "Go", placed with the manual controls (stepper / Drain /
  Drain all) it complements.
- A **quick-action affordance** for the most common case: *"Parallelize tag…"* —
  a small menu that prefills the prompt from a tag picker, so the owner doesn't
  type the boilerplate.
- The **plan preview** = the existing partition editor (HS-8965/8977) rendered
  with the agent's proposed assignment, with accept / edit / cancel.

## 101.3 Coexistence

- **Manual stepper + per-tile dispatch (§92)** — unchanged; this is an additive
  high-level path. The default no-prompt experience is identical.
- **Auto worker pool (§91.11)** — independent. Auto sizes + self-claims
  continuously; the prompt-based manager is a one-shot, owner-initiated, *targeted*
  action ("parallelize THIS set"). They can coexist (a prompt dispatch assigns
  specific chunks; self-claim drains the rest).
- **AI: partition** — the prompt path is the natural successor to the removed
  panel buttons (§91.5/§91.10 HS-9039): instead of a bare "AI: partition" button,
  the owner expresses intent in words and gets the same partition-editor preview.

## 101.4 Open questions

- **Routing to the right agent.** The trigger must reach the **main** owner agent
  (the FIFO leader, never a worker — `pickLeader` already prefers the oldest main
  connection, §89.2/HS-9038). Confirm the worker-management trigger uses that
  routing and is busy-aware (don't stack it on a mid-task main agent — queue or
  warn).
- **Plan-before-execute vs. fire-and-forget.** Default to **showing the plan
  first** (partition editor) for anything that dispatches work; allow a
  fire-and-forget mode for trusted simple prompts? Lean: always preview for v1
  (dispatch is hard to undo once workers start).
- **Prompt scope safety.** A vague prompt ("parallelize everything") could size a
  huge pool — clamp via `poolMax()` and surface the resulting N in the preview for
  confirmation.
- **Failure feedback.** If the agent can't resolve the prompt (no matching
  tickets, ambiguous), it should report back into the panel (a result line),
  ideally via the same channel-done path, not silently.

## 101.5 Tests

- Unit: the prompt-wrapper builds the expected worker-management instruction +
  routes to the main-agent trigger (busy-aware).
- Unit: the quick-action "Parallelize tag…" prefills the prompt from the picked
  tag.
- Integration/e2e: typing a prompt shows the partition-editor preview populated
  from a (mocked) agent plan; accept dispatches via `hotsheet_dispatch_tickets`;
  cancel does nothing.
- Manual-test-plan: the end-to-end live drive (real agent partitions + dispatches)
  — hard to fully automate, like the rest of the pool dashboard.

## 101.6 Follow-up tickets

- **Prompt box + channel-trigger wrapper** in the pool panel (the core). ✅ SHIPPED (HS-9079).
- **"Parallelize tag…" quick action.** — HS-9080.
- **Wire the plan preview** to the HS-8965/8977 partition editor with accept/edit/
  cancel → `hotsheet_dispatch_tickets`. — HS-9080.
- Depends on coherent partitioner grouping (HS-9073, §98) for good default chunks.

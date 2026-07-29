import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { z } from 'zod';

import { canonicalClaudeSourceExists } from './aiInstructions.js';
import { readFileSettings } from './file-settings.js';
import { listMcpHooksAgents } from './mcpHooksAgents.js';
import type { CategoryDef } from './types.js';
import { DEFAULT_CATEGORIES } from './types.js';
import { isExecutableOnPath } from './utils/isExecutableOnPath.js';

// HS-8022 bump — main /hotsheet skill body lost the conditional `/clear` prefix.
// HS-8348 — bumped 9 → 10 for the Phase 3 two-form skill rewrite. The
// `hs-*` ticket-skill body gains an MCP-tool-first / curl-fallback
// pattern; the `hotsheet` main-skill body gains the same two-form
// guidance. SKILL_VERSION bump forces existing seeded skill files to
// re-author on next boot via the `updateFile` upgrade path.
// HS-8863 — bumped 10 → 11 for the new Claude-only `hotsheet-worker` skill
// (the distributed worker loop: claim-next → work → complete + release →
// repeat, docs/90 §90.5/§90.7).
// HS-8962 — bumped 11 → 12: the `hotsheet-worker` loop now honors the
// worker-pool drain signal (`claim-next` may return `{drain:true}` → stop).
// HS-8991 — bumped 12 → 13: dropped the absolute "Base directory: <path>" line
// from the main `hotsheet` skill body (machine-specific path; bad for repos).
// HS-9044 — bumped 13 → 14: git integration workflow. Workers now commit each
// ticket's work + rebase their branch onto the target to stay current (owner is
// the single integrator); the main `hotsheet` skill keeps the target current and
// merges ready worker branches in. Sensible auto-conflict-resolution, ask on hard
// ones (docs/89 §89.5).
// HS-9045 — bumped 14 → 15: workers set `pending_integration: true` when completing
// a ticket whose work they committed (drives the "merge pending" indicator); the
// owner clears it (`pending_integration: false`) when it integrates the branch.
// HS-9050 — bumped 15 → 16: clearer lease-renewal guidance (default lease is now
// 30 min; renew before long steps; claim/renew up to 1 h for high-effort tickets).
// HS-9048 — bumped 16 → 17: the owner integrates worker branches via the new
// `/api/workers/integratable` + `/api/workers/integrate` helpers (deterministic
// git core) instead of hand-rolling the merge.
// HS-9098 — bumped 17 → 18: the owner skill explains the HS-9091 in-helper gate
// statuses (`gate-failed` / `gate-timeout` mean the merge was already rolled back;
// a `merged` with `gate.ran` means the gate already passed — don't re-run it).
// HS-9072 — bumped 18 → 19: the batch-then-pulse cadence (docs/98). The worker
// skill keeps claiming small RELATED tickets onto one branch and runs the §99
// `refreshWorktree` rebase + gates ONCE at the batch boundary (not per ticket),
// isolating large/risky tickets; the owner skill notes a ready branch may carry a
// batch of several tickets (the "branch ready" signal fires once per batch).
// HS-9107 — bumped 19 → 20: when a worker marks a ticket `pending_integration: true`,
// it also passes `integration_branch` (its current branch, e.g. `hotsheet/worker-1`)
// so the owner's "merge pending" badge can review what the ticket added.
// HS-9288 — bumped 20 → 21: the worker skill's "Mark it started" step notes that
// `started` auto-affirms the claim under the worker's id (HS-9198/9208 — the sole
// auto-claim trigger; metadata edits no longer claim), so keep renewing + release.
// HS-9112 — bumped 21 → 22: the main-agent tool list mentions
// `hotsheet_propose_partition` (docs/101 §101.7) — when the project's
// `alwaysPreviewAgentPlans` setting is on (the worklist says so), propose a worker
// partition for owner review instead of dispatching it directly.
// HS-9366 — bumped 22 → 23: adapter mode (docs/118). When the project has a
// canonical Claude source (`CLAUDE.md` + `.claude/skills`), the AGENTS-family
// tree (`.agents/skills`, Antigravity/Codex) is written as THIN ADAPTERS that
// reference the canonical `.claude/skills/<name>/SKILL.md` instead of
// duplicating the body; the bump rewrites existing full-content copies.
export const SKILL_VERSION = 25; // HS-9475 — forces a rewrite of every file that baked in the secret or the port

/**
 * HS-8390 — every long-lived mutable lifecycle ref this module owns lives
 * inside a single named container so a future audit can spot stale handles
 * immediately. Pre-fix the file carried three separately-declared module-level
 * `let`s (`skillPort` / `skillCategories` / `pendingCreatedFlag`), each with
 * its own implicit reset story across tests. Now: read `skillsState.foo`
 * everywhere; reset via `_resetSkillsStateForTesting()` (assigns
 * `freshSkillsState()`).
 *
 * This is the minimal-encapsulation variant of the HS-8390 ticket (vs. the
 * full per-project `SkillsContext` factory, which would require plumbing a
 * context through `projects.ts` + `routes/dashboard.ts` + every callsite —
 * deferred). The struct already gives us: (a) a single grep-able location
 * for every mutable bit, (b) explicit test-reset entry point, (c) a
 * straightforward path forward to the full factory if/when needed (rename
 * `skillsState` to a parameter, drop the module-level slot, expose a
 * `createSkillsContext()`).
 *
 * Note: `skillsState.port` is `number | undefined` — pre-fix `skillPort: number`
 * was declared without an initializer, so the runtime value WAS undefined
 * before `initSkills()` ran but the type lied. The `undefined` typing here
 * matches reality; `ticketSkillBody` and `ensureClaudePermissions` both
 * handle the `undefined` case explicitly now.
 */
interface SkillsState {
  port: number | undefined;
  categories: CategoryDef[];
  /**
   * Tracks whether skills were created/updated in this server session.
   * Consumed once by the UI endpoint so the banner shows even though
   * cli.ts already called ensureSkills() before the page loaded.
   */
  pendingCreatedFlag: boolean;
}

function freshSkillsState(): SkillsState {
  return {
    port: undefined,
    categories: DEFAULT_CATEGORIES,
    pendingCreatedFlag: false,
  };
}

let skillsState: SkillsState = freshSkillsState();

/** **HS-8390 — TEST ONLY.** Reset the module-level `skillsState` to its
 *  fresh shape so consecutive tests start from a clean slate. Production
 *  code never needs to call this; tests can call it in `beforeEach` as
 *  an explicit alternative to the implicit `initSkills` /
 *  `setSkillCategories` reset pattern. */
export function _resetSkillsStateForTesting(): void {
  skillsState = freshSkillsState();
}

export function initSkills(port: number) {
  skillsState.port = port;
}

export function setSkillCategories(categories: CategoryDef[]) {
  skillsState.categories = categories;
}

interface SkillDef {
  name: string;
  category: string;
  label: string;
  description: string;
}

/** The generated `hs-<cat>` skill name for a category id (underscores → dashes).
 *  Shared by `buildTicketSkills` (which authors the skill files) and
 *  `generatedClaudeSkillNames` (which lists them for the worktree approvals
 *  writer) so the two can never drift. */
function ticketSkillName(catId: string): string {
  return `hs-${catId.replace(/_/g, '-')}`;
}

function buildTicketSkills(): SkillDef[] {
  return skillsState.categories.map(cat => ({
    name: ticketSkillName(cat.id),
    category: cat.id,
    label: cat.label.toLowerCase(),
    description: cat.description,
  }));
}

/** HS-9058 (docs/104) — the Claude skill names `ensureClaudeSkills` generates
 *  for `categories` (defaults to the process-global set): the main `hotsheet`
 *  + `hotsheet-worker` skills plus one `hs-<cat>` per category. The worktree
 *  approvals writer (`writeWorktreeApprovals`) pre-approves `Skill(<name>)` for
 *  each so a worker doesn't prompt to invoke them. Kept in lockstep with
 *  `buildTicketSkills` via the shared `ticketSkillName`. */
export function generatedClaudeSkillNames(categories: CategoryDef[] = skillsState.categories): string[] {
  return ['hotsheet', 'hotsheet-worker', ...categories.map(cat => ticketSkillName(cat.id))];
}

// --- Version tracking ---

function versionHeader(): string {
  return `<!-- hotsheet-skill-version: ${SKILL_VERSION} -->`;
}

export function parseVersionHeader(content: string): number | null {
  // Match current format and legacy format with port
  const match = content.match(/<!-- hotsheet-skill-version: (\d+)(?: port: \d+)? -->/);
  if (!match) return null;
  return parseInt(match[1], 10);
}

export function updateFile(path: string, content: string): boolean {
  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf-8');
    const version = parseVersionHeader(existing);
    if (version !== null && version >= SKILL_VERSION) {
      return false;
    }
  }
  writeFileSync(path, content, 'utf-8');
  return true;
}

// --- Shared content ---

function ticketSkillBody(skill: SkillDef, projectRoot: string, _dataDir: string = join(projectRoot, '.hotsheet')): string {
  // `_dataDir` is unused since HS-9475 but kept in the signature: HS-8936 passes a
  // git worktree's OWNER `.hotsheet` here so the skill points at the shared
  // instance (docs/89 §89.2 Phase C), and it is the natural home for anything
  // project-specific this body needs again. Nothing needs resolving today —
  // the port lookup that used to live here (HS-8390:
  // `settings.port ?? skillsState.port ?? 4174`) is gone with the value itself.
  //
  // HS-9475 — NEITHER the secret NOR the port is written into a skill file. These
  // live in `.claude/skills/` / `.cursor/rules/`, which are committed and shared
  // with everyone who clones the repo, and BOTH values are machine-specific:
  // the secret is per-project-per-machine (`.hotsheet/secret.json`, gitignored)
  // and the port is machine-local (`settings.local.json`, gitignored, since
  // HS-9002). A baked-in value is therefore wrong for every other developer AND a
  // guaranteed diff conflict — this file's history already shows the port
  // flip-flopping 4174 ↔ 4177. Both are referenced as env vars, with the lookup
  // spelled out below. (The PREFERRED path, the MCP tool, needs neither.)
  const secretLine = '  -H "X-Hotsheet-Secret: $HOTSHEET_SECRET" \\';
  // HS-8348 — Phase 3 two-form skill body. MCP tool listed first
  // (preferred when the Claude Channel is connected), curl form right
  // below as the universal fallback. The MCP form uses the
  // `hotsheet_create_ticket` tool's FLAT input shape (`{title,
  // category, up_next}`) not the curl form's nested `{title, defaults:
  // {category, up_next}}` — both shapes route to the same REST
  // endpoint, the tool just translates.
  const lines = [
    `Create a new Hot Sheet **${skill.label}** ticket. ${skill.description}.`,
    '',
    '**Parsing the input:**',
    '- If the input starts with "next", "up next", or "do next" (case-insensitive), set `up_next` to `true` and use the remaining text as the title',
    '- Otherwise, use the entire input as the title',
    '',
    '**Create the ticket — MCP tool (preferred when the channel is connected):**',
    `Call the \`hotsheet_create_ticket\` tool with \`{ "title": "<TITLE>", "category": "${skill.category}", "up_next": <true|false> }\`. The tool is schema-validated and routes to the channel server's \`--data-dir\` so there's no chance of cross-project misrouting.`,
    '',
    '**Fallback (curl):**',
    '```bash',
    'curl -s -X POST "http://localhost:$HOTSHEET_PORT/api/tickets" \\',
    '  -H "Content-Type: application/json" \\',
  ];
  lines.push(secretLine);
  lines.push(
    `  -d '{"title": "<TITLE>", "defaults": {"category": "${skill.category}", "up_next": <true|false>}}'`,
    '```',
    '',
    'Set these first. Both are machine-specific and deliberately not stored in this file (which is committed and shared with everyone on the repo):',
    '```bash',
    `export HOTSHEET_PORT=$(node -p "require('./.hotsheet/settings.local.json').port ?? 4174")`,
    `export HOTSHEET_SECRET=$(node -p "require('./.hotsheet/secret.json').secret")`,
    '```',
    '',
    'If the request fails (connection refused or 403), re-read those two files — you may be connecting to the wrong Hot Sheet instance. (Older projects keep `port` and `secret` in `.hotsheet/settings.json` instead.)',
    '',
    'Report the created ticket number and title to the user.',
  );
  return lines.join('\n');
}

function mainSkillBody(projectRoot: string, dataDir: string = join(projectRoot, '.hotsheet')): string {
  // HS-8936 — `dataDir` defaults to this project's `.hotsheet`; a worktree
  // follower passes the OWNER's `.hotsheet` so `/hotsheet` reads the shared
  // worklist (the follower has none of its own). The paths stay relative to the
  // worktree root, so they read e.g. `../<repo>/.hotsheet/worklist.md`.
  const worklistRel = relative(projectRoot, join(dataDir, 'worklist.md'));
  const settingsRel = relative(projectRoot, join(dataDir, 'settings.json'));
  // HS-8022 — the HS-7992 `hotsheet_skill_clear_context` toggle was removed.
  // The `/clear` prefix it prepended was loaded as Skill tool output (not
  // typed at the REPL prompt), so the Claude Code CLI never re-parsed it as
  // a slash command and the model couldn't invoke `/clear` itself either —
  // there is no first-class API for a skill or MCP server to clear context
  // when it fires. Users who want a fresh context per /hotsheet should type
  // `/clear` themselves before invoking the skill.
  return [
    // HS-8991 — no "Base directory: <absolute path>" line: it leaked an
    // absolute, machine-specific path into a file projects may check in, and
    // it was redundant (the worklist/settings references below are relative +
    // self-contained).
    `Read \`${worklistRel}\` and work through the tickets in priority order.`,
    '',
    'For each ticket:',
    '1. Read the ticket details carefully',
    '2. Implement the work described',
    '3. When complete, mark it done via the Hot Sheet UI',
    '',
    'Work through them in order of priority, where reasonable.',
    '',
    'If the worklist says "Auto-Prioritize", follow those instructions to choose and mark tickets as Up Next before working on them.',
    '',
    `If API calls fail (connection refused or 403), re-read \`${settingsRel}\` for the current \`port\` and \`secret\` values — you may be connecting to the wrong Hot Sheet instance.`,
    '',
    // HS-8348 — Phase 3 main-skill MCP-tools mention. The worklist
    // documents the full per-operation two-form layout; this line tells
    // the agent to prefer the MCP path when it's available.
    '**MCP tools (`hotsheet_*`) are preferred over curl when the channel is connected** — see the worklist for per-operation guidance. The 14-tool surface covers ticket lifecycle (`hotsheet_update_ticket`, `hotsheet_create_ticket`, `hotsheet_get_ticket`, `hotsheet_delete_ticket`, `hotsheet_restore_ticket`, `hotsheet_toggle_up_next`, `hotsheet_duplicate_tickets`), bulk operations (`hotsheet_batch`), notes (`hotsheet_edit_note`, `hotsheet_delete_note`), attachments (`hotsheet_add_attachment`), channel signaling (`hotsheet_signal_done`), feedback sugar (`hotsheet_request_feedback`), and query (`hotsheet_query_tickets`). Curl stays supported as the universal fallback for non-Claude AI agents and human terminal callers.',
    '',
    '**Parallelizing work across the worker pool:** `hotsheet_get_worker_pool` / `hotsheet_set_worker_target` / `hotsheet_dispatch_tickets` / `hotsheet_drain_workers`. When the project has **"always preview agent plans"** on (the worklist says so), call **`hotsheet_propose_partition`** with your whole proposed assignment INSTEAD of `hotsheet_dispatch_tickets` — it surfaces the plan in the owner\'s partition editor for review, and the UI dispatches on accept (you do not claim the tickets yourself).',
    '',
    '## Git: keep the target current + integrate worker branches',
    '',
    'You run on the **target branch** (usually `main`) in the main worktree, so you are the **single integrator** for parallel worktree workers (docs/89). Distributed workers (`/hotsheet-worker`) commit their work on their own branches and rebase onto the target to stay current, but they never write the target — that\'s your job:',
    '',
    '- **Stay current** — before integrating, bring the target up to date: `git fetch` then `git pull --rebase` (or rebase onto the upstream) when the repo has a remote, so you build on the latest. Commit or stash your own in-progress changes first so a merge doesn\'t tangle with them.',
    '- **Integrate ready worker branches** — periodically (e.g. when a batch of workers has finished, or the pool drains). Use the **integration helpers** (HS-9048) rather than hand-rolling the git: `GET /api/workers/integratable` returns the detected **target** branch + the **ready** worker branches (`hotsheet/*` ahead of the target, with ahead/behind counts); then for each, in ticket-priority order, `POST /api/workers/integrate` with `{ "branch": "<name>" }` does a guarded merge into the target. It returns a `status`: `merged` (success), `conflict` (it captured the conflicted files + **aborted** cleanly — resolve them by hand or, if non-trivial, ask the maintainer), `dirty-tree` (commit/stash your own changes first), `not-on-target` / `nothing-to-integrate`. The helper **never pushes** — pushing still needs explicit permission.',
    '- **A ready branch may carry a BATCH of several tickets.** Workers batch small/related tickets onto one branch and refresh + gate once at the batch boundary (docs/98), so the "branch ready" signal fires **once per batch**, not per ticket — one `integrateBranch` call + one gate run covers the whole batch. When you integrate it, clear `pending_integration` for **every** ticket whose work it carried (next bullet), not just one.',
    '- **Gates after a merge (and the optional in-helper gate, HS-9091).** After a `merged` result with **no** `gate` field, run the project\'s gates yourself (type-check, lint, the relevant tests). If the project configured the opt-in **`integrationGate`** shared setting, the helper ran that command *inside* the merge and you\'ll get either: `merged` **with `result.gate.ran: true`** (the gate already passed — you do **not** need to re-run those gates for this branch); **`gate-failed`** (the gate command failed and **the merge was already rolled back to the pre-merge target** — do **NOT** re-merge blindly; read `result.gate.output` to decide whether to quickly fix-and-retry or, if non-trivial, ask the maintainer); or **`gate-timeout`** (same rolled-back state, but the gate exceeded its time limit). On `gate-failed`/`gate-timeout` the branch is **unmerged** — leave its ticket\'s `pending_integration` marker set (don\'t clear it).',
    '- For each ticket whose work you just integrated, clear its "merge pending" marker: `hotsheet_update_ticket` with `{ "id": <id>, "pending_integration": false }` (the tickets marked `pending_integration` are the ones awaiting integration).',
    '- **Sensible conflict resolution, ask on the hard ones** — auto-resolve trivial/mechanical conflicts; if a conflict is non-trivial or ambiguous, or the gates fail in a way you can\'t quickly and safely fix, **stop and ask the maintainer** rather than force it (leave the branch unmerged). Integrate only from committed branch state — never disturb a worker mid-ticket.',
    '- **NEVER `git push`** without the maintainer\'s explicit permission — local integration only.',
  ].join('\n');
}

/**
 * HS-8863 — the distributed worker skill (`/hotsheet-worker`, Claude-only). A
 * worker runs this in its own git worktree terminal and loops: `claim-next` the
 * top Up Next ticket → work it → mark `completed` + release → claim again, until
 * the pool is empty. This is the prose mirror of `src/workers/workerLoop.ts` (the
 * programmatic reference for the same invariants); both build on the HS-8862
 * claim/lease MCP tools. Claude-only because it depends on the `hotsheet_*` MCP
 * surface. The durable pool that launches N of these is HS-8962.
 */
function workerSkillBody(projectRoot: string, dataDir: string = join(projectRoot, '.hotsheet')): string {
  // HS-9475 — no port lookup: it is machine-local and no longer embedded here.
  const settingsRel = relative(projectRoot, join(dataDir, 'settings.json'));
  return [
    'You are a **distributed worker** draining the Hot Sheet **Up Next** pool. Multiple workers run in parallel against ONE shared Hot Sheet, each in its own git worktree, coordinated by the atomic claim/lease primitive (docs/90 §90.5) — so you never need to worry about another worker grabbing the same ticket.',
    '',
    '**Your worker identity:** derive a stable `worker` id and `label` from your current working directory — use the worktree folder name (the last path segment of your cwd, e.g. `my-repo-feature-x`) for both. This makes your claims attributable in the maintainer\'s UI.',
    '',
    '## The loop',
    '',
    'Repeat the following until the pool is empty:',
    '',
    '1. **Claim the next ticket.** Call the `hotsheet_claim_next` MCP tool with `{ "worker": "<your-id>", "label": "<your-label>" }`. The default lease is **30 minutes** — plenty for most tickets. Once you\'ve read the ticket and judge it **high-effort** (a big or multi-step change you expect to take a while), claim or immediately renew with a longer `ttlSeconds` (seconds, up to **3600** = 1 hour) so the lease comfortably covers the work.',
    '   - If the response has **`drain: true`**, the worker-pool manager has asked you to shut down (a scale-down). Go straight to **Finishing** — do not claim anything more.',
    '   - If it returns **no ticket** (nothing claimable), the pool is drained — go to **Finishing** below.',
    '   - If it returns a ticket, you now hold an exclusive, time-limited **lease** on it. Continue.',
    '2. **Mark it started.** Call `hotsheet_update_ticket` with `{ "id": <id>, "status": "started" }`.',
    '   - Setting status to `started` also **auto-affirms your claim** under your worker id (HS-9198/9208 — `started` is the *sole* auto-claim trigger; metadata-only edits no longer claim). You already hold the claim from `claim-next`, so this just keeps the ticket attributed to you and write-protected against any *other* actor while you work it. Keep the lease alive by renewing on long work (step 3) and release it when you finish (step 6).',
    '3. **Do the work** described in the ticket details — implement it fully, the same way you would under `/hotsheet`, but for THIS one claimed ticket only.',
    '   - **Heartbeat on long work — don\'t let the lease lapse while you\'re heads-down.** You work in long silent bursts (a single big file read + analysis can run minutes), and nothing renews the lease automatically. So **renew proactively**: call `hotsheet_renew_lease` with `{ "id": <id>, "worker": "<your-id>" }` (optionally a larger `ttlSeconds` up to 3600) **before** starting any step you expect to take several minutes, and again any time you\'ve been working a while without renewing. The 30-minute default gives headroom, but treat renewing as a normal part of long work, not an afterthought. If a renew ever returns `{ "ok": false }`, your lease lapsed and the ticket may have been reclaimed by another worker — **stop working it**, do NOT mark it completed, and go back to step 1.',
    '4. **Commit your work** on your worktree\'s branch with a clear, scoped message referencing the ticket (follow the project\'s git conventions). Commit only what this ticket touched — don\'t sweep in unrelated pending changes. **NEVER `git push`** without the maintainer\'s explicit permission. (You do NOT merge into the target branch yourself — see **Staying in sync** below.)',
    '5. **Complete it.** Call `hotsheet_update_ticket` with `{ "id": <id>, "status": "completed", "notes": "<what you did>" }`. Notes are REQUIRED — describe the specific changes (see the worklist\'s note-formatting guidance). **If you committed code for this ticket (step 4), also pass `"pending_integration": true` AND `"integration_branch": "<your branch>"`** (your worktree\'s branch, e.g. `hotsheet/worker-1` — run `git branch --show-current` if unsure) — `pending_integration` marks the ticket "merge pending" in the owner\'s UI, and `integration_branch` lets the owner review exactly what your branch added before merging. Omit both for tickets with no committed code.',
    '   - **File follow-up tickets** for any incomplete work BEFORE completing (per the project\'s incomplete-work checklist).',
    '6. **Release the claim.** Call `hotsheet_release` with `{ "id": <id>, "worker": "<your-id>" }` so the slot is freed.',
    '7. **Go back to step 1** and claim the next ticket — **batching small, related tickets** onto the SAME branch (see below) instead of refreshing after every one.',
    '',
    '## Batching: amortize the refresh + gates across small, related tickets',
    '',
    'Rebasing, reinstalling deps, and running the full gate suite (type-check / lint / the relevant tests) costs about the same whether a ticket is one line or one hundred. So **don\'t pay it per ticket** — pay it once per **batch**:',
    '',
    '- **Keep claiming small, RELATED tickets onto your current branch.** After you commit a ticket (step 4), if the next claimable ticket is **small and related** — shares files/area, the same tag or category, or is a sibling of the same investigation — and your batch is still modest in size/risk, claim it onto the **same** branch and keep working. Do **not** rebase or run the full gates between them.',
    '- **Isolate large or risky tickets.** A big or open-ended change, a migration, or anything touching a hot/shared module gets its **own** branch (a batch of one), so a failure or a nasty conflict stays contained.',
    '- **Keep dependency chains separate.** Never put a ticket in the same batch as one of its own `blocked_by` dependencies — the dependency must integrate first. (`claim-next` already skips blocked tickets, so what you claim is ready to work; just don\'t co-batch a chain.)',
    '- **Default: batch small/related, isolate large/risky.** Bigger batches save overhead but drift further from the target (a larger conflict surface at integration); smaller batches stay fresher but churn more. Lean toward batching the long tail of small tickets.',
    '',
    'At the **batch boundary** — the next claimable ticket is large/unrelated, the pool drains, or the batch has grown enough — refresh + gate **once** (next section), then hand the branch off.',
    '',
    '## Staying in sync with the target branch — refresh ONCE at the batch boundary',
    '',
    'Your worktree is on its own branch, spun off from the **target branch** (usually `main`). You are **not** the writer of the target — git won\'t even let your worktree update the target while the owner has it checked out. The main Hot Sheet agent (`/hotsheet`) is the **single integrator** that merges ready worker branches into the target. Your job is to keep your branch current and committed so that integration is clean:',
    '',
    '- **Refresh once per batch, on a CLEAN tree** — at the batch boundary (your batch is committed and you\'re between tickets), bring your branch current in one deterministic pulse: clean-tree guard → `git fetch` (if the repo has a remote) → `git rebase <target>` (e.g. `git rebase main`) → **reinstall deps ONLY if the rebase changed `package-lock.json`/`package.json`** (otherwise your gates run against stale `node_modules` — silently green-but-wrong). This is the §99 `refreshWorktree` routine; do it **once per batch, never mid-ticket** (a dirty tree means commit first).',
    '- **Then run the gates once** over the whole batch (type-check / lint / the relevant tests) before handing off — so the overhead is paid once for the batch, not once per ticket.',
    '- **Resolve trivial rebase conflicts and continue** — for an obvious/mechanical conflict (two unrelated additions, a moved import, a doc line), resolve it sensibly and `git rebase --continue`. For anything non-trivial or ambiguous, **`git rebase --abort`**, leave a `FEEDBACK NEEDED:` note on the relevant ticket describing the conflict, signal done, and wait — do **not** force a risky resolution.',
    '- **Hand off, don\'t merge** — leave your committed batch on your branch; the owner (`/hotsheet`) is the single integrator and picks up worker branches ahead of the target. You never merge into the target yourself. **Signal the branch ready once per batch** (not per ticket): call `POST /api/workers/ready` with `{ "worker": "<your-id>", "branch": "<your-branch>" }` so the owner integrates it promptly (the owner also scans `hotsheet/*` as a fallback, so this is an optimization, not required).',
    '',
    '## Finishing',
    '',
    'When `hotsheet_claim_next` returns nothing claimable, the pool is drained — that\'s a batch boundary. Make sure your work is committed, run the refresh pulse + gates once over the batch (above), signal the branch ready, then call `hotsheet_signal_done` and stop. (The owner / worker-pool manager re-triggers you when there is new work — you do not need to poll.)',
    '',
    '## Notes',
    '',
    '- **Crash-safety:** if you die mid-ticket, your lease simply expires and another worker reclaims the ticket automatically — nothing to clean up.',
    '- **Dependencies:** `claim-next` already skips tickets blocked by an unfinished `blocked_by` dependency (docs/90 §90.6), so anything you claim is ready to work.',
    '- **Never** work a ticket you have not successfully claimed, and never complete/release a ticket whose lease you have lost.',
    `- If an MCP call fails, fall back to the REST API at \`http://localhost:$HOTSHEET_PORT/api\` (claim-next: \`POST /api/tickets/claim-next\`; renew: \`POST /api/tickets/:id/renew-lease\`; release: \`POST /api/tickets/:id/release\`). HS-9475 — the port and secret are machine-specific and deliberately not written here; read them from \`.hotsheet/settings.local.json\` (\`port\`) and \`.hotsheet/secret.json\` (\`secret\`), falling back to \`${settingsRel}\` for older projects.`,
  ].join('\n');
}

/**
 * HS-7992 — force-regenerate the main `/hotsheet` skill file for every
 * platform that has been seeded (Claude / Cursor / Copilot / Windsurf).
 * Bypasses the version-check guard in `updateFile` because the regen here
 * was originally triggered by an explicit user action (the General-tab
 * "Clear context on each /hotsheet" toggle), not an upgrade-time recreate.
 *
 * HS-8022 — the toggle was removed (the `/clear` prefix was a no-op when
 * loaded as Skill tool output). The function is kept exported because it
 * is still useful for any future regen-on-explicit-user-action flow, and
 * the SKILL_VERSION bump on this commit means existing files re-author
 * themselves through the normal `updateFile` upgrade path on next boot.
 */
export function regenerateMainSkill(projectRoot: string): void {
  const body = mainSkillBody(projectRoot);
  const targets: { path: string; frontmatter: string[] }[] = [
    {
      path: join(projectRoot, '.claude', 'skills', 'hotsheet', 'SKILL.md'),
      frontmatter: [
        'name: hotsheet',
        'description: Read the Hot Sheet worklist and work through the current priority items',
        'allowed-tools: Read, Grep, Glob, Edit, Write, Bash',
      ],
    },
    {
      path: join(projectRoot, '.cursor', 'rules', 'hotsheet.mdc'),
      frontmatter: [
        'description: Read the Hot Sheet worklist and work through the current priority items',
        'alwaysApply: false',
      ],
    },
    {
      path: join(projectRoot, '.github', 'prompts', 'hotsheet.prompt.md'),
      frontmatter: [
        'description: Read the Hot Sheet worklist and work through the current priority items',
      ],
    },
    {
      path: join(projectRoot, '.windsurf', 'rules', 'hotsheet.md'),
      frontmatter: [
        'trigger: manual',
        'description: Read the Hot Sheet worklist and work through the current priority items',
      ],
    },
  ];
  for (const target of targets) {
    if (!existsSync(target.path)) continue;
    const content = ['---', ...target.frontmatter, '---', versionHeader(), '', body, ''].join('\n');
    writeFileSync(target.path, content, 'utf-8');
  }
}

// --- Claude Code permissions (.claude/settings.json) ---

// Static patterns covering ports 4170-4199 (default 4174 + auto-selected ports up to 4193, with margin)
const HOTSHEET_ALLOW_PATTERNS = [
  'Bash(curl * http://localhost:417*/api/*)',
  'Bash(curl * http://localhost:418*/api/*)',
  'Bash(curl * http://localhost:419*/api/*)',
];

// Matches any old dynamic or current static Hot Sheet curl patterns
const HOTSHEET_CURL_RE = /^Bash\(curl \* http:\/\/localhost:\d+\/api\/\*\)$|^Bash\(curl \* http:\/\/localhost:41[789]\*\/api\/\*\)$/;

function ensureClaudePermissions(cwd: string): boolean {
  // Only configure if port is in the expected range. HS-8390 — explicit
  // undefined check; pre-fix the bare numeric comparison silently
  // succeeded with `NaN < 4170` evaluating false on an uninitialized
  // module-level `let skillPort: number` (the type lied; runtime was
  // undefined). Now we early-return when no port is set.
  const port = skillsState.port;
  if (port === undefined) return false;
  if (port < 4170 || port > 4199) return false;

  const claudeDir = join(cwd, '.claude');
  // HS-8486 (2026-05-22) — pre-fix the `.claude` folder was assumed
  // to exist (the legacy `ensureSkillsForDir` gate required it).
  // Post-fix the gate is "claude is on PATH" which may fire before
  // the user ever creates the folder, so ensure it exists before
  // writing.
  mkdirSync(claudeDir, { recursive: true });
  const settingsPath = join(claudeDir, 'settings.json');

  // HS-8567 — `.loose()` so unrelated user keys round-trip through the
  // overwrite. We only validate the shape we mutate (`permissions.allow`).
  const ClaudeProjectSettingsSchema = z.object({
    permissions: z.object({
      allow: z.array(z.string()).optional(),
    }).loose().optional(),
  }).loose();
  type ClaudeProjectSettings = z.infer<typeof ClaudeProjectSettingsSchema>;
  let settings: ClaudeProjectSettings = {};
  if (existsSync(settingsPath)) {
    try {
      const raw: unknown = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const parsed = ClaudeProjectSettingsSchema.safeParse(raw);
      if (parsed.success) settings = parsed.data;
    } catch { /* corrupt file, overwrite */ }
  }

  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];

  const allow = settings.permissions.allow;
  if (HOTSHEET_ALLOW_PATTERNS.every(p => allow.includes(p))) return false;

  // Remove any old Hot Sheet curl patterns, add the static ones
  settings.permissions.allow = allow.filter(p => !HOTSHEET_CURL_RE.test(p));
  settings.permissions.allow.push(...HOTSHEET_ALLOW_PATTERNS);

  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  return true;
}

// --- SKILL.md-based tools: Claude (.claude/skills) + Antigravity (.agents/skills) ---

/**
 * HS-9326 — write the `hotsheet` + `hotsheet-worker` + per-category ticket skills
 * as `<skillsDir>/<name>/SKILL.md`. Shared by Claude (`.claude/skills`) and
 * Antigravity (`.agents/skills`) — the SKILL.md format (YAML `name`+`description`
 * frontmatter + markdown body) is common; only the directory + whether Claude's
 * `allowed-tools:` line is emitted differ. Bodies come from the same
 * `mainSkillBody`/`workerSkillBody`/`ticketSkillBody` builders.
 */
function writeSkillTree(skillsDir: string, cwd: string, dataDir: string, includeAllowedTools: boolean, adaptToCanonicalDir?: string): boolean {
  let updated = false;
  const allowed = (tools: string): string[] => includeAllowedTools ? [`allowed-tools: ${tools}`] : [];
  const write = (name: string, description: string, allowedTools: string, body: string): void => {
    const dir = join(skillsDir, name);
    mkdirSync(dir, { recursive: true });
    // HS-9366 (docs/118) — adapter mode: when a canonical dir is given and it has
    // this skill, write a thin adapter that references it instead of duplicating
    // the body. Frontmatter (`name` + `description`) is kept for discovery.
    const effectiveBody = adaptToCanonicalDir !== undefined && existsSync(join(adaptToCanonicalDir, name, 'SKILL.md'))
      ? adapterSkillBody(name)
      : body;
    const content = ['---', `name: ${name}`, `description: ${description}`, ...allowed(allowedTools), '---', versionHeader(), '', effectiveBody, ''].join('\n');
    if (updateFile(join(dir, 'SKILL.md'), content)) updated = true;
  };

  write('hotsheet', 'Read the Hot Sheet worklist and work through the current priority items',
    'Read, Grep, Glob, Edit, Write, Bash', mainSkillBody(cwd, dataDir));

  // HS-8863 — the distributed worker skill (depends on the `hotsheet_*` MCP
  // claim/lease tools). Not generated for Cursor/Copilot/Windsurf (no curl-only
  // equivalent loop); agy gets it since it drives the same MCP tools.
  write('hotsheet-worker', 'Run as a distributed worker — continuously claim, work, and release Up Next tickets',
    'Read, Grep, Glob, Edit, Write, Bash', workerSkillBody(cwd, dataDir));

  for (const skill of buildTicketSkills()) {
    write(skill.name, `Create a new ${skill.label} ticket in Hot Sheet`, 'Bash', ticketSkillBody(skill, cwd, dataDir));
  }
  return updated;
}

/**
 * HS-9366 (docs/118) — the thin adapter body written into an AGENTS-family tree
 * (`.agents/skills/<name>/SKILL.md`) when the canonical Claude skill exists.
 * The relative path is FIXED: both trees are repo-root-anchored at the same
 * depth (`<root>/.agents/skills/<name>/` vs `<root>/.claude/skills/<name>/`),
 * so `../../../` always lands on the repo root regardless of platform (markdown
 * paths use forward slashes on every OS). The video-studio model.
 */
function adapterSkillBody(name: string): string {
  return [
    `Read \`../../../.claude/skills/${name}/SKILL.md\` completely and follow its`,
    'workflow. Treat Claude-specific tool names as capability labels and use the',
    'equivalent tools available in the current session. Follow `AGENTS.md` for',
    'repository-wide conventions.',
  ].join('\n');
}

function ensureClaudeSkills(cwd: string, dataDir: string = join(cwd, '.hotsheet')): boolean {
  let updated = false;
  // Ensure curl permissions for Hot Sheet API calls
  if (ensureClaudePermissions(cwd)) updated = true;
  if (writeSkillTree(join(cwd, '.claude', 'skills'), cwd, dataDir, true)) updated = true;
  return updated;
}

// HS-9326 — Antigravity (`agy`) auto-discovers skills at `.agents/skills/<name>/SKILL.md`
// (verified in the agy binary docs — a standard customization root, no `skills.json`
// manifest needed). Codex reads the same root (HS-9366, the video-studio model);
// Gemini CLI reads `.gemini/skills/<name>/SKILL.md` (HS-9374, verified against
// gemini-cli 0.49.0 — same depth, so the fixed `../../../` adapter path holds).
// Same SKILL.md bodies as Claude, minus the Claude-specific `allowed-tools:`
// frontmatter (these tools use their own tool sets).
//
// HS-9366 (docs/118) — adapter mode: when the project has a canonical Claude
// source (`CLAUDE.md` + `.claude/skills`), the tool's tree is written as thin
// adapters referencing the canonical files — and the canonical tree is
// refreshed FIRST (even when `ai_tool` excludes Claude), so the referenced
// content can't go stale while adapters point at it. With no canonical source
// (a project that started on that tool), full bodies are written.
function ensureAdapterSkillTree(cwd: string, dataDir: string, treeDir: string): boolean {
  let updated = false;
  const canonicalDir = join(cwd, '.claude', 'skills');
  const adapter = canonicalClaudeSourceExists(cwd);
  if (adapter) {
    // Keep the canonical source fresh — the adapters delegate to it.
    if (writeSkillTree(canonicalDir, cwd, dataDir, true)) updated = true;
  }
  if (writeSkillTree(treeDir, cwd, dataDir, false, adapter ? canonicalDir : undefined)) updated = true;
  return updated;
}

function ensureAgentsFamilySkills(cwd: string, dataDir: string = join(cwd, '.hotsheet')): boolean {
  return ensureAdapterSkillTree(cwd, dataDir, join(cwd, '.agents', 'skills'));
}

/** HS-9374 — Gemini CLI's skills root (`.gemini/skills`). */
function ensureGeminiSkills(cwd: string, dataDir: string = join(cwd, '.hotsheet')): boolean {
  return ensureAdapterSkillTree(cwd, dataDir, join(cwd, '.gemini', 'skills'));
}

/**
 * HS-9374 — OpenCode discovers skills at `.opencode/skills`, `.claude/skills`
 * AND `.agents/skills` (verified: opencode.ai/docs/skills, installed 1.x). So
 * with a canonical Claude source we must NOT write `.agents/skills` adapters —
 * OpenCode reads the canonical tree directly, and same-`name` adapters would
 * DUPLICATE every skill in its list. Canonical present → just keep it fresh;
 * absent (started-on-OpenCode) → seed full bodies into the shared
 * `.agents/skills` root.
 */
function ensureOpencodeSkills(cwd: string, dataDir: string = join(cwd, '.hotsheet')): boolean {
  if (canonicalClaudeSourceExists(cwd)) {
    return writeSkillTree(join(cwd, '.claude', 'skills'), cwd, dataDir, true);
  }
  return writeSkillTree(join(cwd, '.agents', 'skills'), cwd, dataDir, false);
}

// HS-9327 — the interactive-permission PreToolUse hook for agy. A command in the
// hook's `command` field identifies OUR entry, so we can merge in/out without
// touching the user's other hooks.
const AGY_HOOK_MARKER = '__agy-permission-hook';

/** Resolve the `<cli> __agy-permission-hook` command (dev tsx vs prod node/dist),
 *  quoting paths for the shell. Mirrors `getChannelServerPath`'s dev/prod probe. */
function agyPermissionHookCommand(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const distCli = join(thisDir, 'cli.js'); // prod: skills.ts is bundled into dist/cli.js
  if (existsSync(distCli)) return `"${process.execPath}" "${distCli}" ${AGY_HOOK_MARKER}`;
  const srcCli = join(thisDir, 'cli.ts'); // dev: src/skills.ts sibling
  if (existsSync(srcCli)) return `npx tsx "${srcCli}" ${AGY_HOOK_MARKER}`;
  return `"${process.execPath}" "${distCli}" ${AGY_HOOK_MARKER}`;
}

function hookGroupIsOurs(group: unknown): boolean {
  if (typeof group !== 'object' || group === null) return false;
  const hooks = (group as { hooks?: unknown }).hooks;
  return Array.isArray(hooks) && hooks.some(h =>
    typeof h === 'object' && h !== null
    && typeof (h as { command?: unknown }).command === 'string'
    && ((h as { command: string }).command).includes(AGY_HOOK_MARKER));
}

/**
 * HS-9327 — install (or, when the setting is off, remove) our PreToolUse permission
 * hook in agy's `.agents/hooks.json`, MERGING with the user's other hooks/events.
 * Gated on `antigravity_interactive_permissions`. Best-effort (won't clobber a
 * corrupt hooks.json). Returns true when a write happened.
 */
function ensureAntigravityHooks(cwd: string, dataDir: string = join(cwd, '.hotsheet')): boolean {
  const hooksPath = join(cwd, '.agents', 'hooks.json');
  const want = readFileSettings(dataDir).antigravity_interactive_permissions === true;

  let config: Record<string, unknown> = {};
  if (existsSync(hooksPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(hooksPath, 'utf-8'));
      if (typeof parsed === 'object' && parsed !== null) config = parsed as Record<string, unknown>; // guarded
    } catch { return false; } // corrupt → don't clobber the user's file
  }
  const prev = Array.isArray(config.PreToolUse) ? (config.PreToolUse as unknown[]) : [];
  const others = prev.filter(g => !hookGroupIsOurs(g)); // drop any prior Hot Sheet hook
  const next = want
    ? [...others, { '//': 'Hot Sheet interactive permissions', matcher: '', hooks: [{ type: 'command', command: agyPermissionHookCommand(), timeout: 600 }] }]
    : others;

  if (next.length > 0) config.PreToolUse = next; else delete config.PreToolUse;
  const serialized = Object.keys(config).length === 0 ? '' : JSON.stringify(config, null, 2) + '\n';

  const before = existsSync(hooksPath) ? readFileSync(hooksPath, 'utf-8') : '';
  if (serialized === before) return false; // idempotent
  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, serialized, 'utf-8');
  return true;
}

// HS-9359 — the interactive-permission hooks for Codex. Same marker-based
// merge-in/merge-out model as agy's, but codex's `.codex/hooks.json` nests
// events under a top-level `hooks` object and each group nests `hooks` entries
// under a `matcher` (the Claude schema; verified live on codex-cli 0.145.0).
const CODEX_HOOK_MARKER = '__codex-permission-hook';

/** Resolve the `<cli> __codex-permission-hook` command (dev tsx vs prod node/dist). */
function codexPermissionHookCommand(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  const distCli = join(thisDir, 'cli.js'); // prod: skills.ts is bundled into dist/cli.js
  if (existsSync(distCli)) return `"${process.execPath}" "${distCli}" ${CODEX_HOOK_MARKER}`;
  const srcCli = join(thisDir, 'cli.ts'); // dev: src/skills.ts sibling
  if (existsSync(srcCli)) return `npx tsx "${srcCli}" ${CODEX_HOOK_MARKER}`;
  return `"${process.execPath}" "${distCli}" ${CODEX_HOOK_MARKER}`;
}

function codexHookGroupIsOurs(group: unknown): boolean {
  if (typeof group !== 'object' || group === null) return false;
  const hooks = (group as { hooks?: unknown }).hooks;
  return Array.isArray(hooks) && hooks.some(h =>
    typeof h === 'object' && h !== null
    && typeof (h as { command?: unknown }).command === 'string'
    && ((h as { command: string }).command).includes(CODEX_HOOK_MARKER));
}

/**
 * HS-9359 — install (or, when the setting is off, remove) our permission hooks in
 * the project's `.codex/hooks.json`, MERGING with the user's other hooks/events.
 * Two events (both feed the same `__codex-permission-hook` CLI → §47 overlay):
 *  - `PreToolUse`, matcher-scoped to the MUTATING tools
 *    (`Bash|apply_patch|Edit|Write`) — read-only tools and Hot Sheet's own
 *    `hotsheet_*` MCP calls skip the overlay (codex matchers are Rust regex — no
 *    negative lookahead — so the scoping is an explicit allow-list of gated tools).
 *  - `PermissionRequest`, matcher `*` — answers codex approval requests (e.g. an
 *    MCP call under `--sandbox workspace-write`, which exec mode otherwise
 *    auto-cancels); the hook itself auto-allows `hotsheet_*` tools.
 * Gated on `codex_interactive_permissions`. Best-effort (won't clobber a corrupt
 * hooks.json). Returns true when a write happened.
 */
function ensureCodexHooks(cwd: string, dataDir: string = join(cwd, '.hotsheet')): boolean {
  const hooksPath = join(cwd, '.codex', 'hooks.json');
  const want = readFileSettings(dataDir).codex_interactive_permissions === true;

  let config: Record<string, unknown> = {};
  if (existsSync(hooksPath)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(hooksPath, 'utf-8'));
      if (typeof parsed === 'object' && parsed !== null) config = parsed as Record<string, unknown>; // guarded
    } catch { return false; } // corrupt → don't clobber the user's file
  }
  const events = typeof config.hooks === 'object' && config.hooks !== null && !Array.isArray(config.hooks)
    ? { ...(config.hooks as Record<string, unknown>) } // guarded above
    : {};

  const hookEntry = { type: 'command', command: codexPermissionHookCommand(), timeout: 180 };
  const wanted: Record<string, { matcher: string }> = {
    PreToolUse: { matcher: '^(Bash|apply_patch|Edit|Write)$' },
    PermissionRequest: { matcher: '*' },
  };
  for (const [event, { matcher }] of Object.entries(wanted)) {
    const prev = Array.isArray(events[event]) ? (events[event] as unknown[]) : [];
    const others = prev.filter(g => !codexHookGroupIsOurs(g)); // drop any prior Hot Sheet group
    const next = want ? [...others, { matcher, hooks: [hookEntry] }] : others;
    if (next.length > 0) events[event] = next; else delete events[event]; // eslint-disable-line @typescript-eslint/no-dynamic-delete
  }

  if (Object.keys(events).length > 0) config.hooks = events; else delete config.hooks;
  const serialized = Object.keys(config).length === 0 ? '' : JSON.stringify(config, null, 2) + '\n';

  const before = existsSync(hooksPath) ? readFileSync(hooksPath, 'utf-8') : '';
  if (serialized === before) return false; // idempotent
  mkdirSync(dirname(hooksPath), { recursive: true });
  writeFileSync(hooksPath, serialized, 'utf-8');
  return true;
}

// --- Cursor (.cursor/rules/*.mdc) ---

function ensureCursorRules(cwd: string): boolean {
  let updated = false;
  const rulesDir = join(cwd, '.cursor', 'rules');
  mkdirSync(rulesDir, { recursive: true });

  // Main rule
  const mainContent = [
    '---',
    'description: Read the Hot Sheet worklist and work through the current priority items',
    'alwaysApply: false',
    '---',
    versionHeader(),
    '',
    mainSkillBody(cwd),
    '',
  ].join('\n');
  if (updateFile(join(rulesDir, 'hotsheet.mdc'), mainContent)) updated = true;

  // Per-type rules
  for (const skill of buildTicketSkills()) {
    const content = [
      '---',
      `description: Create a new ${skill.label} ticket in Hot Sheet`,
      'alwaysApply: false',
      '---',
      versionHeader(),
      '',
      ticketSkillBody(skill, cwd),
      '',
    ].join('\n');
    if (updateFile(join(rulesDir, `${skill.name}.mdc`), content)) updated = true;
  }

  return updated;
}

// --- GitHub Copilot (.github/prompts/*.prompt.md) ---

function ensureCopilotPrompts(cwd: string): boolean {
  let updated = false;
  const promptsDir = join(cwd, '.github', 'prompts');
  mkdirSync(promptsDir, { recursive: true });

  // Main prompt
  const mainContent = [
    '---',
    'description: Read the Hot Sheet worklist and work through the current priority items',
    '---',
    versionHeader(),
    '',
    mainSkillBody(cwd),
    '',
  ].join('\n');
  if (updateFile(join(promptsDir, 'hotsheet.prompt.md'), mainContent)) updated = true;

  // Per-type prompts
  for (const skill of buildTicketSkills()) {
    const content = [
      '---',
      `description: Create a new ${skill.label} ticket in Hot Sheet`,
      '---',
      versionHeader(),
      '',
      ticketSkillBody(skill, cwd),
      '',
    ].join('\n');
    if (updateFile(join(promptsDir, `${skill.name}.prompt.md`), content)) updated = true;
  }

  return updated;
}

// --- Windsurf (.windsurf/rules/*.md) ---

function ensureWindsurfRules(cwd: string): boolean {
  let updated = false;
  const rulesDir = join(cwd, '.windsurf', 'rules');
  mkdirSync(rulesDir, { recursive: true });

  // Main rule
  const mainContent = [
    '---',
    'trigger: manual',
    'description: Read the Hot Sheet worklist and work through the current priority items',
    '---',
    versionHeader(),
    '',
    mainSkillBody(cwd),
    '',
  ].join('\n');
  if (updateFile(join(rulesDir, 'hotsheet.md'), mainContent)) updated = true;

  // Per-type rules
  for (const skill of buildTicketSkills()) {
    const content = [
      '---',
      'trigger: manual',
      `description: Create a new ${skill.label} ticket in Hot Sheet`,
      '---',
      versionHeader(),
      '',
      ticketSkillBody(skill, cwd),
      '',
    ].join('\n');
    if (updateFile(join(rulesDir, `${skill.name}.md`), content)) updated = true;
  }

  return updated;
}

// --- Public API ---

/** Ensure skills for a specific project root directory.
 *
 *  **HS-8486 (2026-05-22)** — detection switched from "AI tool's
 *  project folder exists" to "AI tool's CLI is installed on PATH"
 *  (with the project-folder check kept as a fallback so projects
 *  that already had the folder still get covered). The change
 *  ensures skill files are installed BEFORE the user's first
 *  launch of the AI tool — pre-fix the user had to start the AI
 *  tool at least once for the folder to exist + Hot Sheet to
 *  install skills, which meant the first AI invocation in a new
 *  project ran without the Hot Sheet skill in scope. Copilot keeps
 *  the folder-only gate because there's no reliable executable
 *  name to probe for (it lives inside VS Code as an extension). */
export function ensureSkillsForDir(projectRoot: string, categories?: CategoryDef[], dataDir: string = join(projectRoot, '.hotsheet')): string[] {
  // HS-8910 — generate against THIS project's categories, not whatever the
  // process-global `skillsState.categories` was last set to. The "ensure skills
  // for ALL projects" loops (dashboard.ts / channel.ts / cli.ts) pass each
  // project's own categories so one project's custom category (e.g. a Marketing
  // `m`) can't leak an `hs-m` skill into every OTHER project. Set immediately
  // before the fully SYNCHRONOUS generation below — no await follows, so
  // concurrent callers can't interleave between this assignment and its use in
  // `buildTicketSkills`. Falls back to the global when omitted (bare `ensureSkills`).
  if (categories !== undefined) skillsState.categories = categories;
  const platforms: string[] = [];

  // HS-9311 (docs/113 §113.3) — when the project's `ai_tool` is an explicit choice
  // (not `auto`), seed ONLY that tool's skill/rule files instead of every detected
  // tool — so a machine with several tool folders doesn't get noise from the ones
  // this project doesn't use. `auto` (default) keeps the detect-and-seed-everything
  // behavior. `wants` never DELETES already-seeded files for a now-unselected tool
  // (they just stop being refreshed) — a non-destructive narrowing.
  const wants = wantsTool(dataDir);

  if (wants('claude') && (isExecutableOnPath('claude') || existsSync(join(projectRoot, '.claude')))) {
    // HS-8936 — `dataDir` defaults to `projectRoot/.hotsheet`; a worktree follower
    // passes the OWNER's `.hotsheet` so `/hotsheet` + the curl skills target the
    // shared instance's worklist + port/secret (docs/89 §89.2 Phase C).
    if (ensureClaudeSkills(projectRoot, dataDir)) platforms.push('Claude Code');
  }
  if (wants('cursor') && (isExecutableOnPath('cursor') || existsSync(join(projectRoot, '.cursor')))) {
    if (ensureCursorRules(projectRoot)) platforms.push('Cursor');
  }
  if (wants('copilot') && (existsSync(join(projectRoot, '.github', 'prompts')) || existsSync(join(projectRoot, '.github', 'copilot-instructions.md')))) {
    if (ensureCopilotPrompts(projectRoot)) platforms.push('GitHub Copilot');
  }
  if (wants('windsurf') && (isExecutableOnPath('windsurf') || existsSync(join(projectRoot, '.windsurf')))) {
    if (ensureWindsurfRules(projectRoot)) platforms.push('Windsurf');
  }

  // HS-9320 / HS-9339 — spawn-based MCP+hooks agents (docs/115) have no skill files for
  // the tools (they consume the `hotsheet_*` MCP tools directly), so instead of a skill
  // generator we register the cwd-resolving channel server in the agent's GLOBAL MCP
  // config (a single entry serves every project; idempotent + best-effort). This now
  // iterates the per-agent registry (`mcpHooksAgents.ts`) so a second spawn agent's
  // config-write needs no new code here. Each is gated on its binary being present.
  for (const agent of listMcpHooksAgents()) {
    if (!wants(agent.aiTool) || !isExecutableOnPath(agent.binary)) continue;
    agent.ensureMcpConfig();
    // Antigravity extras (worklist skills + the interactive-permission hook) stay
    // agy-specific for now — their on-disk format is agent-specific; generalize them
    // against a real second agent when one lands (HS-9339 note).
    if (agent.aiTool === 'antigravity') {
      // HS-9326 — seed the /hotsheet worklist skills into agy's `.agents/skills/`
      // (HS-9366: thin adapters when the canonical Claude source exists).
      if (ensureAgentsFamilySkills(projectRoot, dataDir)) platforms.push('Antigravity');
      // HS-9327 — install/remove the interactive-permission PreToolUse hook per the
      // `antigravity_interactive_permissions` setting (idempotent, merge-safe).
      ensureAntigravityHooks(projectRoot, dataDir);
    }
    if (agent.aiTool === 'codex') {
      // HS-9359 — install/remove the interactive-permission hooks (`.codex/hooks.json`)
      // per the `codex_interactive_permissions` setting (idempotent, merge-safe).
      ensureCodexHooks(projectRoot, dataDir);
    }
  }

  // HS-9366 (docs/118) — Codex reads the AGENTS.md standard + `.agents/skills`
  // (the video-studio model), so a codex project gets the same skill tree the
  // Antigravity branch writes: thin adapters when the canonical Claude source
  // exists, full bodies otherwise. Idempotent when both agents seeded it.
  if (wants('codex') && (isExecutableOnPath('codex') || existsSync(join(projectRoot, 'AGENTS.md')))) {
    if (ensureAgentsFamilySkills(projectRoot, dataDir)) platforms.push('Codex');
  }

  // HS-9374 (docs/118 §118.4a) — OpenCode reads `.claude/skills` DIRECTLY (plus
  // `.agents/skills` / `.opencode/skills`): with a canonical source, only keep it
  // fresh (adapters would duplicate names in its skill list); without one, seed
  // full bodies into `.agents/skills`.
  if (wants('opencode') && (isExecutableOnPath('opencode') || existsSync(join(projectRoot, 'AGENTS.md')))) {
    if (ensureOpencodeSkills(projectRoot, dataDir)) platforms.push('OpenCode');
  }

  // HS-9374 — Gemini CLI: `GEMINI.md` context + `.gemini/skills` discovery
  // (verified against gemini-cli 0.49.0). Adapter mode like the AGENTS family.
  if (wants('gemini') && (isExecutableOnPath('gemini') || existsSync(join(projectRoot, 'GEMINI.md')) || existsSync(join(projectRoot, '.gemini')))) {
    if (ensureGeminiSkills(projectRoot, dataDir)) platforms.push('Gemini');
  }

  if (platforms.length > 0) {
    skillsState.pendingCreatedFlag = true;
  }
  return platforms;
}

/**
 * HS-9311 — a predicate: should this tool's skills be seeded for the project?
 * Reads the `ai_tool` file-setting (default `auto`). `auto` → every tool (today's
 * behavior); an explicit tool → only that one. Goose is now the only CLI agent
 * with no skill generator (its conventions are unverified — not installed; see
 * HS-9374/docs/118 §118.6): it matches no branch, so nothing is seeded.
 */
export function wantsTool(dataDir: string): (tool: string) => boolean {
  const raw = readFileSettings(dataDir).ai_tool;
  const aiTool = typeof raw === 'string' && raw.trim() !== '' ? raw.trim().toLowerCase() : 'auto';
  return (tool: string) => aiTool === 'auto' || aiTool === tool;
}

/** Ensure skills for the current working directory (backward compat). */
export function ensureSkills(): string[] {
  return ensureSkillsForDir(process.cwd());
}

export function consumeSkillsCreatedFlag(): boolean {
  const result = skillsState.pendingCreatedFlag;
  skillsState.pendingCreatedFlag = false;
  return result;
}

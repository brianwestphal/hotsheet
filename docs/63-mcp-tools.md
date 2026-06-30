# 63. MCP Tools for AI Agents

## 63.1 Overview

Hot Sheet's channel server (`src/channel.ts`) is an MCP server registered in `.mcp.json` when the Claude Channel is enabled (§12). Today it only exposes **outbound notifications** (`claude/channel` worklist events, `claude/channel/permission_request`). It defines **zero MCP tools** — every Claude → Hot Sheet operation (status update, ticket create, completion signal, attachment upload, FEEDBACK NEEDED note) is a `curl` call against the REST API documented in §9.

This document specifies the **inbound tool surface** the channel server should expose so an AI agent connected over MCP can perform those operations through schema-validated tool calls instead of hand-formatted shell commands.

### Motivation

The curl pattern has four specific failure modes the tool surface eliminates:

1. **Shell-escape pain on note bodies.** Backticks, dollar signs, single/double quotes, and newlines all need careful escaping. The worklist instructs Claude to write a temp file + use `--data-binary @file` for long notes, but agents regularly get this wrong on the first try and either truncate the note or inject syntax errors into the body. MCP tool calls pass JSON natively — no shell layer.
2. **Wrong-instance routing.** The agent has to grab `port` + `secret` from `<dataDir>/settings.json` and not hardcode them. Multi-project setups multiply the bookkeeping; HS-8340 was caused by exactly this kind of cross-project misrouting. MCP tools auto-scope to the channel server's `--data-dir`.
3. **No type safety on the input shape.** `category`, `priority`, `status` are free-form strings in a curl payload; typos are caught by the server's Zod validation but the agent's prompt has no schema-driven guardrail. MCP tools declare a JSON Schema; the agent's tool-use planner sees the enum directly.
4. **Per-call token cost.** A curl PATCH for status + notes is ~120 tokens of prompt + ~80 tokens of response (the full echoed ticket JSON). The equivalent MCP tool call is ~30 tokens both ways. Across a worklist with ~10 ticket updates per session, that is a meaningful reduction.

### Migration approach (soft cutover)

The REST API documented in §9 stays as-is. **MCP tools are an additional path, not a replacement.** Prompts and skill files (`worklist.md`, `hs-*` skills) list the MCP form first with the curl form right below as "Fallback when channel is not connected" — see §63.6.

This serves three constituencies:

- **Claude Code sessions with the channel enabled** — get the type-safe, low-token MCP path.
- **Other AI agents (Cursor, Aider, etc.)** that don't speak our MCP capability — keep using the curl path; nothing changes for them.
- **Human callers at the terminal** — `curl` remains the documented and supported integration shape.

## 63.2 Tool Surface

All tools live under the `hotsheet_` prefix so they sort together in the agent's tool list and don't collide with tools from other MCP servers. Each tool's JSON Schema mirrors the corresponding REST endpoint's Zod schema (see `src/routes/validation.ts`).

### Ticket lifecycle

| Tool | REST equivalent | Purpose |
|------|-----------------|---------|
| `hotsheet_update_ticket` | `PATCH /api/tickets/:id` | Status, notes, priority, category, up_next, tags. **HS-9198/9208 claim-before-work:** a write to a ticket another actor holds with a live lease is rejected **409 `claimed_by_other`** (every write). Auto-claim, though, fires **only when the write transitions status to `started`** (the response then carries a `claim` block with a renew/release reminder) — **metadata-only edits no longer auto-claim** (HS-9208). Terminal tickets + read-tracking-only writes are exempt. The worker's actor id is auto-injected by its channel server (`basename(cwd)`, matching its `claim_next` id); the owner/main agent is `owner`. See docs/90 §90.2.2.1 |
| `hotsheet_create_ticket` | `POST /api/tickets` | Create a new ticket |
| `hotsheet_get_ticket` | `GET /api/tickets/:id` | Re-read a single ticket's current state |
| `hotsheet_delete_ticket` | `DELETE /api/tickets/:id` | Soft-delete (moves to trash) |
| `hotsheet_restore_ticket` | `POST /api/tickets/:id/restore` | Restore a soft-deleted ticket |
| `hotsheet_toggle_up_next` | `POST /api/tickets/:id/up-next` | Toggle the up_next flag |
| `hotsheet_duplicate_tickets` | `POST /api/tickets/duplicate` | Duplicate one or more tickets |

### Bulk operations

| Tool | REST equivalent | Purpose |
|------|-----------------|---------|
| `hotsheet_batch` | `POST /api/tickets/batch` | Bulk status / category / priority / delete / restore / mark-read / mark-unread / up_next on `{ids: number[]}` |

### Notes

| Tool | REST equivalent | Purpose |
|------|-----------------|---------|
| `hotsheet_edit_note` | `PATCH /api/tickets/:id/notes/:noteId` | Edit an individual note's body |
| `hotsheet_delete_note` | `DELETE /api/tickets/:id/notes/:noteId` | Delete an individual note |

### Attachments

| Tool | REST equivalent | Purpose |
|------|-----------------|---------|
| `hotsheet_add_attachment` | `POST /api/tickets/:id/attachments` | Upload a file by absolute path. Tool reads the file from disk and posts multipart on the agent's behalf so the agent never deals with `-F` form syntax |

### Distributed-execution claim/lease (HS-8862, docs/90 §90.4)

A worker agent drains the Up Next pool in parallel without double-claiming.

| Tool | REST equivalent | Purpose |
|------|-----------------|---------|
| `hotsheet_claim_next` | `POST /api/tickets/claim-next` | Atomically claim the top claimable Up Next ticket for `{worker, label?, ttlSeconds?}` (`SELECT … FOR UPDATE SKIP LOCKED`). Returns `{ticket}` or `{ticket:null}` when nothing is claimable |
| `hotsheet_renew_lease` | `POST /api/tickets/:id/renew-lease` | Heartbeat — extend the lease while working a ticket. `{ok:false}` ⇒ the claim lapsed, re-claim |
| `hotsheet_release` | `POST /api/tickets/:id/release` | Release a claim (on completion / handback). Idempotent |
| `hotsheet_set_blocked_by` | `PUT /api/tickets/:id/blocked-by` | Set a ticket's flat dependency gate (`{ticket_id, blocker_ids}`) — claim-next skips it until every blocker is completed/verified. For a planning pass; rejects self/unknown/cycle (400). Flat only, never a tree (HS-8865) |

### Worker-pool management (HS-9031, docs/90 §90 / docs/91)

So an AI tool (Claude) can parallelize work across the distributed pool — e.g. "parallelize all tickets tagged X": query the tickets (`hotsheet_query_tickets`), scale the pool, split, and dispatch a chunk per worker.

| Tool | REST equivalent | Purpose |
|------|-----------------|---------|
| `hotsheet_get_worker_pool` | `GET /api/workers/pool` | List the pool: target count + each worker (id, label, state, current ticket). For seeing capacity before dispatching, or monitoring progress |
| `hotsheet_set_worker_target` | `POST /api/workers/pool/target` | Scale the pool to a target worker count. **Caveat:** new workers only actually START while the owner UI is open — launch is client-driven (docs/89 Phase C), so with no UI open this records the intent only (follow-up: server-driven launch) |
| `hotsheet_dispatch_tickets` | loops `POST /api/tickets/:id/claim` | Assign (claim-by-id) a chunk of tickets to one worker, so it works them first (before the shared pool). The "parallelize" primitive. Returns `{worker, dispatched:[ids], failed:[{id,reason}]}` — an already-live-claimed ticket lands in `failed` (409), not reassigned |
| `hotsheet_drain_workers` | `POST /api/workers/pool/drain` or `…/drain-all` | Gracefully drain one worker (`{worker}`) or every worker (`{all:true}`) — finishes the current ticket, then stops; never killed mid-work |

### Channel signaling

| Tool | REST equivalent | Purpose |
|------|-----------------|---------|
| `hotsheet_signal_done` | `POST /api/channel/done` | Mark the agent as idle. Replaces the `curl ... /api/channel/done` line at the bottom of every worklist event |

### Sugar helpers (not direct REST mirrors)

| Tool | Wraps | Purpose |
|------|-------|---------|
| `hotsheet_request_feedback` | `update_ticket` with notes-prefix injection | Takes `{ticket_id, question, urgent?}`. Prepends `FEEDBACK NEEDED:` or `IMMEDIATE FEEDBACK NEEDED:` depending on `urgent`, then PATCHes the ticket with the note. Saves the agent from remembering the exact prefix text |

### Advanced query

| Tool | REST equivalent | Purpose |
|------|-----------------|---------|
| `hotsheet_query_tickets` | `POST /api/tickets/query` | Custom-view-style query over `{logic, conditions, sort_by?, sort_dir?, required_tag?, include_archived?}`. For agents that need to dig deeper than the worklist provides |
| `hotsheet_announce` (HS-8771) | `POST /api/announcer/announce` | Push a curated §80 Announcer highlight (`{title, highlight}`) for a notable moment — pre-empts the derived narration queue with a low-latency entry (no AI summarization). No-op if the project hasn't enabled the Announcer. HS-8772 added an optional `diff` (`{oldStr, newStr, filePath?}`) → a §78.5 tier-2 code-diff visual rendered in the PIP. (15th tool; `CHANNEL_VERSION` → 10, then → 11 for the `diff` field.) |

**Tool count: 23** (`CHANNEL_VERSION`/`EXPECTED_CHANNEL_VERSION` → 12 with the HS-8862 claim/lease trio, → 13 with HS-8865 `hotsheet_set_blocked_by`, → 14 with the HS-9045 `pending_integration` input, → 15 with the HS-9031 worker-pool quartet `hotsheet_get_worker_pool` / `hotsheet_set_worker_target` / `hotsheet_dispatch_tickets` / `hotsheet_drain_workers`).

**Deliberately not exposed:** `GET /api/tickets` (list), `GET /api/tags`, `GET /api/stats`, `GET /api/dashboard`, all settings/backups/projects/channel-management/gitignore/glassbox endpoints. The worklist file already gives the agent everything it needs for the standard flow; surfacing `list_tickets` trains agents to bypass the worklist. Agents that genuinely need these endpoints can `curl` them through the documented fallback path.

## 63.3 Tool implementation

As built, the tool definitions, per-tool Zod schemas, the `tools/list` catalog, and the `tools/call` dispatch + localhost-HTTP proxy all live in a dedicated `src/channel.tools.ts`; `src/channel.ts` only registers the `tools/list` + `tools/call` handlers and imports from it. The dispatcher:

1. Validates the input against a Zod schema (reuse the existing schemas in `src/routes/validation.ts` where possible — they are the source of truth for the REST API and re-using them keeps the two surfaces in lockstep).
2. Resolves `port` + `secret` for the project (the channel server already has `dataDir` from its `--data-dir` CLI arg). HS-9007: `port` is read from the RESOLVED file settings (`readFileSettings` merges `settings.json` + the gitignored `settings.local.json`, since HS-9002 relocated `port` to the local layer) and `secret` from the `secret.json` sidecar (`getProjectSecret`, HS-8999). Reading `settings.json` alone — the original behavior — returned null on every migrated project, breaking all `hotsheet_*` tools.
3. Issues a localhost HTTP request to the main Hot Sheet server with `X-Hotsheet-Secret: <secret>` header set. This is the same code path the REST API serves; no second handler tree.
4. Returns the response body as the MCP tool result. For mutation endpoints that echo the full ticket JSON, the tool returns it verbatim so the agent can confirm the change applied.
5. On error (non-2xx status, network failure, JSON parse failure), returns a `{ isError: true, content: [{ type: 'text', text: '<message>' }] }` MCP tool result. The agent sees a structured error instead of a swallowed exception.

### Why proxy-to-HTTP, not direct PGLite?

The channel server runs as a separate process from the main Hot Sheet server (spawned by Claude Code over stdio, not by `hotsheet`). Direct PGLite access would require either (a) opening a second connection to the same database — PGLite's single-writer model would conflict — or (b) IPC out-of-band of the existing HTTP path. The localhost HTTP hop adds <1 ms of latency on every call and dedupes every piece of business logic (Zod validation, markdown sync triggers, change-version bumping, attachment-backup hashing). The added cost is dwarfed by the LLM round-trip cost the tool call sits inside.

### `CHANNEL_VERSION` bump

Adding tools changes the channel server's capability surface. Bump both `CHANNEL_VERSION` in `src/channel.ts` AND `EXPECTED_CHANNEL_VERSION` in `src/channel-config.ts` (per the CLAUDE.md convention). Users who have the channel registered will see a "reconnect via `/mcp`" prompt when the main server boots with the newer version.

## 63.4 Multi-project scoping

**Status:** Shipped 2026-05-13 under HS-8349.

The channel server is registered per-project in each project's `.mcp.json` with a project-specific `--data-dir`. A single Claude Code session that has multiple Hot Sheet projects open ends up with one MCP server per project — Claude Code namespaces tools by the `.mcp.json` key. To keep the tool names distinguishable when multiple Hot Sheet projects are connected, the channel server registers itself as `hotsheet-channel-<project-slug>` where the slug is derived from the basename of the project root (parent of `.hotsheet/`). Inside each server, tools are still named `hotsheet_*` — Claude Code's full tool name becomes `mcp__hotsheet-channel-<slug>__hotsheet_update_ticket`.

The slug is computed by `slugifyDataDir(dataDir)` in `src/channel-config.ts`: lowercase the basename, collapse non-alphanumeric runs to a single `-`, trim leading/trailing `-`. If the result is empty (basename contained no alphanumerics) it falls back to `project`. Both the `.mcp.json` registration key (`getMcpServerKey(dataDir)`) and the MCP `Server({name})` value in `src/channel.ts` use the slug-suffixed name, so the registration key, the server's announced name, and the dev-channel command (`claude --dangerously-load-development-channels server:hotsheet-channel-<slug>`) all agree. The slug-suffixed dev-channel command is built by `claudeWithChannelCommand(dataDir)` in `src/terminals/resolveCommand.ts` and rendered by the Settings → Experimental panel via the `serverName` field on `GET /api/channel/status`.

**Migration.** `registerChannel(dataDir)` opportunistically drops any legacy `hotsheet-channel` entry on the same `.mcp.json` when writing the new slug-suffixed key. `unregisterChannel(dataDir)` removes both the per-project slug-suffixed key and the legacy single-key entry. The `CHANNEL_VERSION` / `EXPECTED_CHANNEL_VERSION` bump from 6 → 7 prompts the version-mismatch warning in the main UI so existing users reconnect via `/mcp` after upgrading.

Pre-fix: every project's MCP server registered as `hotsheet-channel`, Claude Code silently disambiguated by spawn order and the user could not tell which `hotsheet_update_ticket` belonged to which project. Post-fix the slug makes the routing visible in the agent's tool list.

## 63.5 Testing strategy

New test file `src/channel.tools.test.ts`:

- **Happy path per tool** — input passes Zod validation, proxy HTTP call returns 2xx, tool returns echoed JSON.
- **Validation rejection** — bad enum value, missing required field, wrong type — tool returns `isError: true` with the Zod issue messages.
- **HTTP error propagation** — main server returns 404 / 403 / 500 — tool returns `isError: true` with the status + body.
- **Missing settings.json** — channel server's `<dataDir>/settings.json` is absent — tool returns `isError: true` with a clear "channel server not connected to main server" message.
- **Multi-project tool naming** — given two channel-server instances with different `--data-dir`s, the server names differ.

Existing `src/channelPermissions.test.ts` already exercises the outbound notification path; that is unchanged.

## 63.6 Documentation rollout

### `.hotsheet/worklist.md` (template lives in `src/sync/markdown.ts`)

The current worklist opens with a "Workflow" section that lists curl commands for status updates. Restructure so each operation block has two forms:

```
- **BEFORE starting work on a ticket**, set its status to "started":

  **MCP tool (preferred when the channel is connected):**
  Call the `hotsheet_update_ticket` tool with `{ "id": <id>, "status": "started" }`.

  **Fallback (curl):**
  curl -s -X PATCH http://localhost:4174/api/tickets/{id} \
    -H "Content-Type: application/json" \
    -H "X-Hotsheet-Secret: <secret>" \
    -d '{"status": "started"}'
```

Same shape for the "completed with notes" pattern, the "Creating tickets" section, the "Uploading attachments" section, the "FEEDBACK NEEDED" section, and the channel-done curl that appears in every channel event. Total worklist size grows by ~30%, but per-operation guidance becomes unambiguous.

### `.claude/skills/hs-*/SKILL.md` (×8 files: `hs-bug`, `hs-feature`, `hs-task`, `hs-issue`, `hs-investigation`, `hs-req-change`, `hs-requirement-change`, `hs-m`)

Each skill currently contains a single curl POST recipe. Each gets a two-form block: "If the `hotsheet_create_ticket` MCP tool is available, call it with `{title, defaults: {category, up_next}}`. Otherwise run the curl POST below." All eight skills follow the same template — generate from a single source if practical to avoid drift, or maintain them as parallel copies and write a `src/skills/syncSkillFiles.ts` test that asserts they stay in step.

### `.claude/skills/hotsheet/SKILL.md`

Already minimal (it points the agent at the worklist). One-line addition: "MCP tools (`hotsheet_*`) are preferred over curl when the channel is connected — see the worklist for per-operation guidance."

### `docs/12-claude-channel.md`

Add a §12.13 "MCP Tools" subsection pointing at this document for the full tool reference. The channel doc keeps describing the channel server's lifecycle, outbound notifications, and permission relay; the tool surface lives here.

### `docs/9-api.md`

Add a brief "MCP tool equivalents" callout at the top of §9 (before §9.0): "Every endpoint in this document has an equivalent MCP tool when accessed by an AI agent through the Claude Channel. See [63-mcp-tools.md](63-mcp-tools.md) for the tool surface. The REST API documented below is the universal interface and the source of truth for input validation."

### `CLAUDE.md`

- Add this file to the doc reading order (between §62 and the Tauri docs).
- The existing `CHANNEL_VERSION` / `EXPECTED_CHANNEL_VERSION` Conventions bullet already covers the version-bump rule; no edit needed there.

### `docs/ai/code-summary.md` and `docs/ai/requirements-summary.md`

- Code summary: `src/channel.ts` row picks up the tool surface (size, tool count, the `hotsheet_` prefix, the proxy-to-localhost-HTTP pattern).
- Requirements summary: new §63 entry with status marker matching the implementation phase.

## 63.7 Implementation phasing

Tracked in follow-up tickets filed under HS-8344:

- **Phase 1 — MCP tool infrastructure + 5-tool core.** Add `tools/list` + `tools/call` handlers to `src/channel.ts`. Implement `hotsheet_update_ticket`, `hotsheet_create_ticket`, `hotsheet_signal_done`, `hotsheet_add_attachment`, `hotsheet_request_feedback`. Bump versions. New `src/channel.tools.test.ts`. Worklist + `hotsheet` skill updated to mention the tools generically.
- **Phase 2 — Full coverage.** Remaining tools: `get_ticket`, `delete_ticket`, `restore_ticket`, `toggle_up_next`, `duplicate_tickets`, `batch`, `edit_note`, `delete_note`, `query_tickets`. Tests for each.
- **Phase 3 — Worklist + skill rewrite.** `.hotsheet/worklist.md` template and all 8 `hs-*` skills get the two-form layout. `.claude/skills/hotsheet/SKILL.md` line added.
- **Phase 4 — Multi-project tool naming.** Slug derivation, server-name suffix, manual-test entry. **Shipped 2026-05-13 under HS-8349** — pulled forward from the deferred queue once the user confirmed multi-project support was load-bearing rather than polish.
- **Phase 5 — Doc rollout.** §12.13, §9.0 callout, AI summaries updated. Done in lockstep with Phase 1 so the docs land with the first shipped tools.

All five phases now shipped. Phases 1, 3, 5 landed together as the MVP shipment; Phase 2 followed once Phase 1 was exercised in a real session; Phase 4 closed the multi-project gap.

## 63.8 Non-goals

- **Replacing the REST API.** The REST API stays as the universal interface. MCP tools are an additional access path for AI agents.
- **Tool calls that long-poll.** `/api/poll`, `/api/channel/permission`, `/api/projects/permissions` are long-poll endpoints. MCP tools are inherently single-request; long-polling belongs in the channel server's notification path (which already exists for permission requests).
- **Exposing project / settings / backup management.** These are user-administrative operations, not agent-workflow operations. Agents that need them can curl.
- **Exposing the channel's own lifecycle.** `/api/channel/enable` / `disable` / `claude-check` are Settings-UI operations, not agent operations.

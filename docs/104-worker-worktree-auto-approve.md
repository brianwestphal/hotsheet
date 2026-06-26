# 104. Auto-Approve Worker Worktree MCP Server + Skills

**Status: DESIGN ONLY** (HS-9058, 2026-06-26). Implementation follow-up to the
HS-9046 investigation. A new worker prompts on first launch to (a) allow the MCP
server connection and (b) allow the worker skills — breaking the autonomous flow.
Make Hot Sheet **pre-approve both** by writing the **worktree's**
`.claude/settings.local.json` when it wires the worktree
([89-git-worktrees.md](89-git-worktrees.md) §89.2 Phase C, `createWorktree` →
`registerChannelAt` + `ensureSkillsForDir`). Extends the auto-allow-rule mechanism
([64-claude-allow-rule.md](64-claude-allow-rule.md)).

## 104.0 Problem

A worker is an autonomous `claude "/hotsheet-worker"` terminal in a fresh
worktree. On first launch Claude Code prompts to:
- **Allow the MCP server** (`hotsheet-channel-<slug>`) — for the `hotsheet_*`
  tools.
- **Allow the skills** (`/hotsheet-worker`, `/hotsheet`, the `hs-<cat>` category
  skills) — to invoke them.

Each prompt stalls the worker until a human clicks. For headless / auto-scaled
workers (§91.11, §100) that's fatal — there's nobody to click. We already
pre-approve the MCP **tool calls** for the main project (§64); the worktree needs
the same treatment plus the server-enable + skill-invocation approvals.

## 104.1 What to write into `<worktree>/.claude/settings.local.json`

Merge (preserve existing keys), mirroring `src/claude-allow-rule.ts`'s
read-mutate-write + the `claude_auto_allow_rule` opt-out:

- **`enabledMcpjsonServers: ["hotsheet-channel-<slug>"]`** — skips the per-server
  "Allow MCP server X?" approval. `<slug>` = `getMcpServerKey(ownerDataDir)` /
  `slugifyDataDir`. (`enableAllProjectMcpServers: true` is the broad alternative;
  prefer the explicit single-server entry.)
- **`permissions.allow` +=**
  - `mcp__hotsheet-channel-<slug>__*` — the existing tool wildcard
    (`claudeAllowRulePattern(ownerDataDir)`) — pre-approves the `hotsheet_*` tool
    calls. **This is the bug below**: it's not written to worktrees today.
  - `Skill(hotsheet-worker)`, `Skill(hotsheet)`, and `Skill(hs-<cat>)` for each
    generated category skill — pre-approves skill **invocation**.

All writes are merge + idempotent + failure-open, and gated on the per-project
`claude_auto_allow_rule:false` opt-out (read from the owner's settings, since the
worktree is a follower).

## 104.2 The bug to fix as part of this

`syncClaudeAllowRule(dataDir)` is called **only** from `registerChannel(dataDir)`
(the main-project path), **not** from `registerChannelAt(root, dataDir)` (the
worktree path `createWorktree` uses). Worse, it derives `.claude/` from the
**owner** project root (`projectRoot(dataDir)`), not the worktree `root`.
Confirmed in source:

- `channel-config.ts::registerChannelAt` — *"Does NOT touch the Claude allow-rule
  (dataDir-rooted; owned by `registerChannel`)."*
- `claude-allow-rule.ts` — `settingsLocalPath` → `claudeDir(dataDir)` →
  `projectRoot(dataDir)` = the **owner's** project root.

**Net:** a worktree's `.claude/settings.local.json` never receives the MCP-tools
allow rule — so even the `hotsheet_*` tool calls prompt in a worker today. The new
writer must target the **worktree root** (`createWorktree`'s `path`), exactly like
`registerChannelAt` / `ensureSkillsForDir` already do — not the owner root.

### Fix shape

Add a worktree-targeted writer (e.g. `syncClaudeAllowRuleAt(root, ownerDataDir)`
or a small `writeWorktreeApprovals(worktreeRoot, ownerDataDir, skillNames)`) that:
- resolves `.claude/settings.local.json` under the **worktree `root`** (not the
  owner),
- uses `getMcpServerKey(ownerDataDir)` for the server key / tool wildcard,
- writes `enabledMcpjsonServers` + the `permissions.allow` entries (tool wildcard
  + `Skill(...)` per generated skill),
- respects the owner's `claude_auto_allow_rule` opt-out,
and is called from `createWorktree` alongside `registerChannelAt` +
`ensureSkillsForDir` (which already know the worktree root + the generated skill
names). The existing dataDir-rooted `syncClaudeAllowRule` stays for the main
project; refactor the shared read-mutate-write so both paths use it without
duplicating the JSON merge.

## 104.3 Known limitation (document it — can't fix via files)

Claude Code's **workspace-trust dialog** ("Do you trust the files in this
directory?") gates a brand-new directory and, per the Claude Code docs, **cannot
be pre-approved by any settings file** — it's an interactive security gate,
accepted once per worktree then remembered. So the **first** launch of a worker in
a fresh worktree still shows the trust prompt; this feature eliminates the
MCP-server + skill prompts but not the trust prompt. (Revisit if Claude Code adds
a file-based trust mechanism.) Capture this in docs/64 + the manual test plan so
the residual one prompt is expected, not a bug.

## 104.4 Tests

A worktree-wiring test (mirror `worktrees.test.ts` / `channel-config.test.ts`)
asserting the worktree's `settings.local.json`:
- gets `enabledMcpjsonServers: ["hotsheet-channel-<slug>"]`,
- gets `permissions.allow` containing `mcp__hotsheet-channel-<slug>__*` +
  `Skill(hotsheet-worker)` / `Skill(hotsheet)` / `Skill(hs-<cat>)`,
- **merges** with a pre-existing `settings.local.json` (preserves unrelated keys),
- respects `claude_auto_allow_rule:false` (writes nothing),
- targets the **worktree root**, not the owner root (the regression guard for the
  §104.2 bug).

## 104.5 Follow-up tickets

- **Worktree-targeted approvals writer** (`enabledMcpjsonServers` + tool wildcard +
  `Skill(...)`) called from `createWorktree`; refactor the shared read-mutate-write
  with `claude-allow-rule.ts` (§104.1-104.2). **The core.**
- **Fix the worktree allow-rule gap** — ensure the MCP-tools wildcard reaches the
  worktree root (folded into the writer above; called out separately because it's
  a live bug, not just new behavior).
- **Docs** — note the residual workspace-trust prompt in docs/64 + the manual test
  plan (§104.3).

# 64. Auto-allow Hot Sheet MCP tools in `.claude/settings.local.json` (HS-8376 design, HS-8377 implementation)

**Status:** Shipped 2026-05-13. `src/claude-allow-rule.ts` lands the writer + remover; `src/channel-config.ts::registerChannel` calls `syncClaudeAllowRule(dataDir)` after the `.mcp.json` write, and `unregisterChannel(dataDir)` calls `unsyncClaudeAllowRule(dataDir)` after the `.mcp.json` cleanup. 18 unit tests in `claude-allow-rule.test.ts` + 4 integration tests in `channel-config.test.ts`.

When a user enables the Claude Channel on a project that has a `.claude/` directory, Hot Sheet should automatically write the MCP tool-allow rule into `.claude/settings.local.json` so Claude Code accepts every `hotsheet_*` MCP tool call without per-call permission prompts. Without this, the user has to manually add the rule to a file they may not even know exists — and the rule shape (`mcp__hotsheet-channel-{slug}__*`) is non-obvious because Claude Code's wildcard support requires the slug to appear before the trailing `__*` (wildcards only match after the second `__`).

This feature is the natural companion to the HS-8344 / HS-8346 / HS-8347 MCP tool surface (§63) and the HS-8349 per-project server naming. Together they make the AI-agent workflow approximately zero-config: install Hot Sheet, enable the channel, and Claude Code can call every Hot Sheet tool from the first prompt without permission friction.

Depends on [12-claude-channel.md](12-claude-channel.md) §12 (channel lifecycle, `.mcp.json` registration), [63-mcp-tools.md](63-mcp-tools.md) §63 (MCP tool surface), and HS-8349's per-project naming convention (`mcp__hotsheet-channel-<slug>__*`).

## 64.1 Motivation

Pre-feature, a Hot Sheet user with the channel enabled has three permission-friction options when working with Claude Code:

1. **Approve every tool call manually.** Each `hotsheet_*` call triggers a Claude Code permission prompt the first time per session, slowing down what was supposed to be a streamlined workflow.
2. **Pick "Always allow" on the first prompt per tool.** Claude Code writes a narrow rule (e.g. `mcp__hotsheet-channel-myproject__hotsheet_update_ticket`) into `.claude/settings.local.json` for that one tool, but the next tool (`hotsheet_create_ticket`, etc.) still prompts on its first use. The user accumulates 14 rules over time, one per Hot Sheet tool.
3. **Manually edit `.claude/settings.local.json` to add the wildcard rule.** Requires the user to know (a) that the file exists, (b) the exact rule shape (`mcp__hotsheet-channel-<slug>__*`), and (c) where to derive `<slug>` from. The slug is `slugifyDataDir(dataDir)` (HS-8349); few users will reverse-engineer that.

None of these are reasonable defaults for a tool whose value proposition is friction-free AI-agent collaboration. The auto-allow rule eliminates options 1 and 2 entirely and removes the discoverability problem in option 3.

## 64.2 Decisions

These design questions were considered and locked in. Each "decision" line records what we're shipping; the "alt" line records the path not taken and why.

### D1 — Where does the write happen?

**Decision:** Piggyback on `registerChannel(dataDir)` in `src/channel-config.ts`. The Hot Sheet "Enable Claude Channel" toggle (and the boot-time `registerChannelForAll` sweep) already calls this for every dataDir, so the auto-allow write happens in lockstep with the `.mcp.json` write. The pair stay consistent: if the channel is registered, the allow rule is present.

**Alt:** Run on every Hot Sheet boot regardless of channel state. Rejected because (a) it touches a user-owned file even when the user has the channel disabled, (b) it duplicates work, (c) the `registerChannel` path is already the canonical "channel is on for this project" moment.

### D2 — Auto-remove on `unregisterChannel`?

**Decision:** Yes, remove the rule on `unregisterChannel(dataDir)` for symmetry with the `.mcp.json` cleanup. The user disabling the channel signals "I don't want Hot Sheet's MCP server on this project for now", and an orphan allow rule pointing at a no-longer-registered server is clutter — it'll silently match nothing.

**Alt:** Leave the rule on disable so the user doesn't lose any manual customizations. Rejected because the rule shape is fixed (`mcp__hotsheet-channel-<slug>__*`) — there's nothing for the user to have customized. If they manually added a different pattern (e.g. a narrower one for a specific tool), our writer's match-by-exact-string idempotence rule (§64.3) leaves that alone.

### D3 — Create `.claude/settings.local.json` if it doesn't exist?

**Decision:** Yes, when `.claude/` is present but `settings.local.json` is missing, create a minimal `{ "permissions": { "allow": ["mcp__hotsheet-channel-<slug>__*"] } }` file. The whole point of the feature is to remove manual setup friction — refusing to create the file would leave a user who's never customized Claude Code permissions stuck on the very first tool call.

**Alt:** Only modify an existing file. Rejected because a fresh Claude Code installation may not have written `settings.local.json` yet; the user shouldn't have to bootstrap it manually.

### D4 — What if `.claude/` itself doesn't exist?

**Decision:** Skip silently. `.claude/` absence is the unambiguous signal that the user isn't using Claude Code on this project — there's no reasonable thing to create. Hot Sheet doesn't ship a "scaffold Claude Code for me" feature, and starting now would surprise users on multi-project setups where Claude Code is only set up for some projects.

**Alt:** Create `.claude/settings.local.json` unconditionally. Rejected — creating the parent directory is too aggressive.

### D5 — Idempotence + non-disruption guarantees.

**Decision:** Three rules, in order:

1. **No duplicate writes.** If `permissions.allow` already contains the exact rule string, skip the write entirely (don't even re-format the file).
2. **No re-formatting.** Read → parse → mutate `allow` array → write back with 2-space indent (matching Claude Code's own convention). Preserve any other keys / formatting outside the `allow` array as-is.
3. **No re-ordering.** Append the new rule to the end of `allow`. Don't sort or de-dup existing entries.

These ensure that running `registerChannel` repeatedly is safe and that hand-edited customizations elsewhere in the file survive untouched. Test coverage in §64.4 enforces each rule.

### D6 — Failure-open behavior.

**Decision:** If `.claude/settings.local.json` exists but is malformed (invalid JSON, unexpected shape) OR if the write fails (permission error, disk full), log a warning to stderr and continue. Channel registration must not fail because the allow-rule write failed — the user's worst case is "MCP tools still prompt for permission", which is no worse than the pre-feature baseline.

**Alt:** Throw on parse error. Rejected because a user with a deliberately hand-edited `.claude/settings.local.json` shouldn't lose their channel enable just because our parser disagreed with their shape.

### D7 — User opt-out.

**Decision:** Ship a per-project boolean setting `claude_auto_allow_rule` (default `true`) in `<dataDir>/settings.json`. When `false`, `registerChannel` skips the allow-rule write entirely (and `unregisterChannel` skips the removal). A user who maintains `.claude/settings.local.json` by hand can flip this off and Hot Sheet will stop touching the file.

No UI surface in v1 — power users who care will discover the key via the `<dataDir>/settings.json` file. A Settings → Experimental toggle can land in a follow-up if the demand materializes.

**Alt:** No opt-out (always-on). Rejected because the file is user-owned and any forced-modify policy could surprise people with non-default Claude Code workflows.

## 64.3 Implementation pattern

New file `src/claude-allow-rule.ts` (or co-located in `channel-config.ts` — TBD during implementation):

```ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { getMcpServerKey } from './channel-config.js';

const ClaudeSettingsSchema = z.object({
  permissions: z.object({
    allow: z.array(z.string()).default([]),
  }).default({}),
}).loose();

function allowRulePattern(dataDir: string): string {
  // `getMcpServerKey` returns `hotsheet-channel-<slug>`. The Claude Code
  // allow-rule pattern is `mcp__<serverKey>__*`.
  return `mcp__${getMcpServerKey(dataDir)}__*`;
}

function projectRoot(dataDir: string): string {
  return dataDir.replace(/\/.hotsheet\/?$/, '');
}

/** HS-8376 — add the `mcp__hotsheet-channel-<slug>__*` rule to
 *  `.claude/settings.local.json`'s `permissions.allow` array. No-op when
 *  `.claude/` is absent, the rule is already present, or the per-project
 *  `claude_auto_allow_rule` setting is `false`. Creates the file with a
 *  minimal shape when `.claude/` exists but `settings.local.json` doesn't.
 *  Failure-open: warnings to stderr, never throws. */
export function syncClaudeAllowRule(dataDir: string): void { /* ... */ }

/** HS-8376 — remove the `mcp__hotsheet-channel-<slug>__*` rule from
 *  `.claude/settings.local.json`'s `permissions.allow` array. Symmetric
 *  counterpart called from `unregisterChannel`. No-op when the rule isn't
 *  present or the file doesn't exist. Failure-open. */
export function unsyncClaudeAllowRule(dataDir: string): void { /* ... */ }
```

Wired into `src/channel-config.ts`:

```ts
export function registerChannel(dataDir: string): void {
  // ... existing .mcp.json write ...
  syncClaudeAllowRule(dataDir);
}

export function unregisterChannel(dataDir?: string): void {
  // ... existing .mcp.json cleanup ...
  if (dataDir !== undefined) unsyncClaudeAllowRule(dataDir);
}
```

The opt-out check reads `<dataDir>/settings.json` via the existing `getFileSettings(dataDir)` helper; absence / parse failure treats the key as `true` (default-on).

## 64.4 Testing strategy

Unit tests in `src/claude-allow-rule.test.ts` (or co-located in `channel-config.test.ts`) using a tmp dir:

- **`syncClaudeAllowRule`:**
  - `.claude/` absent → no file created, no error.
  - `.claude/` present + `settings.local.json` absent → file created with `{ permissions: { allow: ["mcp__hotsheet-channel-<slug>__*"] } }`.
  - `.claude/settings.local.json` present without the rule → rule appended to existing `allow` array.
  - Rule already present → no-op (file content byte-identical pre/post call).
  - Other allow-array entries (`Bash(...)`, `WebFetch(...)`) preserved verbatim.
  - Other top-level keys (e.g. `model`, `env`) preserved verbatim.
  - Malformed JSON in `.claude/settings.local.json` → warning logged, no throw, file unchanged.
  - `claude_auto_allow_rule: false` in `<dataDir>/settings.json` → no-op.
  - Two distinct projects produce two distinct allow rules with distinct slugs (multi-project parity with HS-8349).
- **`unsyncClaudeAllowRule`:**
  - Rule present → removed; other entries preserved.
  - Rule absent → no-op.
  - File doesn't exist → no-op.

Integration test in `channel-config.test.ts`:

- `registerChannel(dataDir)` writes `.mcp.json` AND `.claude/settings.local.json` in one call when `.claude/` exists.
- `unregisterChannel(dataDir)` removes from both files.

## 64.5 Phasing

- **HS-8376 — design only (2026-05-13).** Requirements + seven decisions (§64.2) locked.
- **HS-8377 — implementation (shipped 2026-05-13).** `src/claude-allow-rule.ts` exposes `syncClaudeAllowRule(dataDir)` + `unsyncClaudeAllowRule(dataDir)` + the `claudeAllowRulePattern(dataDir)` helper. `src/channel-config.ts::registerChannel` invokes `syncClaudeAllowRule(dataDir)` after the `.mcp.json` write; `unregisterChannel(dataDir)` invokes `unsyncClaudeAllowRule(dataDir)` after the `.mcp.json` cleanup (only on the dataDir-known path — the no-arg legacy stale-cleanup path can't resolve the slug and leaves the file alone). Per-project `claude_auto_allow_rule` boolean lives in `<dataDir>/settings.json` (default `true` via the absence path), read through the existing `readFileSettings(dataDir)`. 18 unit tests in `src/claude-allow-rule.test.ts` covering each §64.4 case; 4 integration tests in `src/channel-config.test.ts` under a new `register/unregisterChannel × claude-allow-rule integration (HS-8377)` describe block. No `CHANNEL_VERSION` bump — `.mcp.json` semantics unchanged.

## 64.6 Non-goals

- **A UI toggle for `claude_auto_allow_rule`.** A `<dataDir>/settings.json` edit is sufficient for the rare power user who wants to opt out. Surface in Settings → Experimental can be added later if requested.
- **Auto-allow rules for non-Hot-Sheet MCP servers.** Out of scope — this feature is specific to the channel server Hot Sheet itself spawns.
- **Migrating legacy `mcp__hotsheet-channel__*` rules.** Pre-HS-8349 a user might have manually added the non-slugged `mcp__hotsheet-channel__*` rule. The new per-project rule will sit alongside it. We don't auto-remove the legacy entry because we can't tell whether the user added it intentionally — they may have a separate non-slugged channel server.
- **Cross-platform path quirks.** `.claude/settings.local.json` semantics are Claude Code conventions and identical across platforms; the implementation uses `node:path` `join` so Windows path separators work.

## 64.7 Cross-refs

- [12-claude-channel.md](12-claude-channel.md) §12 — channel lifecycle, `.mcp.json` registration shape.
- [63-mcp-tools.md](63-mcp-tools.md) §63 — the 14 `hotsheet_*` MCP tools the allow rule unlocks.
- HS-8349 — per-project server naming (`hotsheet-channel-<slug>`); the allow rule's wildcard scope ends at the second `__`, so the slug must be embedded into the pattern.
- HS-7951 / HS-7952 / HS-7953 (§47) — Hot Sheet's own permission allow-list mechanism. Conceptually adjacent — both let a user pre-approve repetitive tool calls — but they operate on different surfaces (Hot Sheet's permission overlay vs. Claude Code's MCP-tool permission) and use different storage (Hot Sheet's `permission_allow_rules` in `<dataDir>/settings.json` vs. Claude Code's `permissions.allow` in `.claude/settings.local.json`). No code shared.

## 64.8 Residual workspace-trust prompt for fresh worktrees (HS-9086, expected — not a bug)

Claude Code shows a **workspace-trust dialog** ("Do you trust the files in this directory?") the **first time** it opens a brand-new directory. This is a separate gate from the MCP-tool / skill permissions this doc covers, and — unlike those — it **cannot be pre-approved by any settings file** (it's keyed to the directory's trust state, which Claude Code tracks itself, not a `.claude/settings*.json` key).

So a freshly-created git-worktree worker (docs/89) still shows **that one prompt** on its first launch, even after **HS-9058** (docs/104) writes the worktree's `.claude/settings.local.json` to pre-approve the MCP server + skills and so eliminates the *tool*-permission prompts. The sequence on a brand-new worker worktree is therefore: one workspace-trust prompt (unavoidable today), then no further allow prompts for the `hotsheet-channel-<slug>` tools or the generated skills.

- **Status:** expected behavior, documented so it isn't re-filed as a bug. There is no Hot Sheet-side fix — the trust gate is owned by Claude Code.
- **Revisit if** Claude Code adds a file-based / directory-allowlist trust mechanism (e.g. a settable trusted-paths key); at that point `createWorktree` could pre-trust the worktree the same way it writes the approvals (HS-9085).
- Tracked as a manual item in `docs/manual-test-plan.md` §7.

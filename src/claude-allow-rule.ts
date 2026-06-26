import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { z } from 'zod';

import { getMcpServerKey } from './channel-config.js';
import { readFileSettings } from './file-settings.js';

/**
 * HS-8376 / HS-8377 — auto-allow Hot Sheet's MCP tools in
 * `.claude/settings.local.json` so Claude Code accepts every `hotsheet_*`
 * tool call without per-call permission prompts. The wildcard rule is
 * `mcp__hotsheet-channel-<slug>__*` where `<slug>` is `slugifyDataDir`
 * (HS-8349). Claude Code's wildcard support only kicks in after the
 * second `__`, so the slug must be embedded into the pattern rather than
 * passed as a separate matcher.
 *
 * The two `*ClaudeAllowRule` functions are called from `registerChannel` /
 * `unregisterChannel` (in `channel-config.ts`) so the allow rule stays in
 * lockstep with the `.mcp.json` entry — enabling the channel adds it,
 * disabling removes it.
 *
 * HS-9058 (docs/104) — a worktree worker additionally needs the MCP **server**
 * enabled + the worker **skills** pre-approved. `writeWorktreeApprovals` writes
 * those into the WORKTREE's `.claude/settings.local.json`. The owner-rooted
 * `syncClaudeAllowRule` never reached worktrees (§104.2 bug), so the read-mutate-
 * write core was extracted (`mutateClaudeSettings`) and both paths share it.
 *
 * Design + decision rationale lives in `docs/64-claude-allow-rule.md` +
 * `docs/104-worker-worktree-auto-approve.md`.
 */

/** Match the Claude-Code allow-array entries (`permissions.allow`) plus
 *  `enabledMcpjsonServers` (HS-9058), and preserve every other key the user
 *  might have under `permissions` and at the top level. `.loose()` at both
 *  levels keeps the unrelated keys byte-stable across our read-mutate-write
 *  cycle. `enabledMcpjsonServers` is typed (not just `.loose()` pass-through)
 *  because the worktree approvals writer reads + appends to it. */
const ClaudeSettingsSchema = z.object({
  enabledMcpjsonServers: z.array(z.string()).optional(),
  permissions: z.object({
    allow: z.array(z.string()).default([]),
  }).loose().default(() => ({ allow: [] })),
}).loose();

type ClaudeSettings = z.infer<typeof ClaudeSettingsSchema>;

/** Compute the wildcard rule pattern for a given project. The pattern
 *  shape is `mcp__hotsheet-channel-<slug>__*` — Claude Code expands the
 *  trailing `*` to match every tool the server exposes. */
export function claudeAllowRulePattern(dataDir: string): string {
  return `mcp__${getMcpServerKey(dataDir)}__*`;
}

/** Resolve the project root (parent of `.hotsheet/`). Mirrors the same
 *  helper in `channel-config.ts` — kept local so this module doesn't
 *  depend on a private function in another file. HS-8715 — the separator
 *  class accepts BOTH `/` and `\` so it strips `.hotsheet` on Windows too;
 *  a forward-slash-only regex left the segment attached and `.claude/` was
 *  looked up under the dataDir instead of the project root. */
function projectRoot(dataDir: string): string {
  return dataDir.replace(/[\\/]\.hotsheet[\\/]?$/, '');
}

/** Resolve `<root>/.claude/settings.local.json` for an explicit project root.
 *  HS-9058 — the worktree approvals writer targets the WORKTREE root directly,
 *  while the dataDir-rooted `settingsLocalPath` below is the main-project
 *  wrapper (derives the owner project root from its `.hotsheet`). */
function settingsLocalPathForRoot(root: string): string {
  return join(root, '.claude', 'settings.local.json');
}

function claudeDir(dataDir: string): string {
  return join(projectRoot(dataDir), '.claude');
}

function settingsLocalPath(dataDir: string): string {
  return settingsLocalPathForRoot(projectRoot(dataDir));
}

/** §64.2 D7 — read the per-project opt-out boolean. Default `true` when
 *  the key is missing or `<dataDir>/settings.json` is unreadable, so the
 *  feature is on out of the box. Any non-`false` value is treated as
 *  `true` (defensive — a malformed value shouldn't silently disable). */
function isAutoAllowRuleEnabled(dataDir: string): boolean {
  try {
    const settings = readFileSettings(dataDir);
    return settings.claude_auto_allow_rule !== false;
  } catch {
    return true;
  }
}

/** Read + parse the `.claude/settings.local.json` at `path`. Returns `null` on
 *  parse failure so the caller knows to abort without writing back a fresh
 *  shape over a user-intended-but-malformed file. Returns
 *  `{ permissions: { allow: [] } }` when the file is missing. */
function readClaudeSettingsAt(path: string): ClaudeSettings | null {
  if (!existsSync(path)) return { permissions: { allow: [] } };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const parsed = ClaudeSettingsSchema.safeParse(raw);
    if (!parsed.success) {
      console.warn(`[claude-allow-rule] ${path}: ${parsed.error.message}; leaving file untouched`);
      return null;
    }
    return parsed.data;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[claude-allow-rule] Failed to parse ${path}: ${msg}; leaving file untouched`);
    return null;
  }
}

/** Write `.claude/settings.local.json` at `path` with 2-space indent + trailing
 *  newline (matches Claude Code's own convention). Creates the parent `.claude/`
 *  if it doesn't exist. Failure-open: a write error is logged, never thrown. */
function writeClaudeSettingsAt(path: string, settings: ClaudeSettings): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[claude-allow-rule] Failed to write ${path}: ${msg}; channel registration continues`);
  }
}

/** HS-9058 — shared read-mutate-write core. Read the settings at `path`, run
 *  `mutate` (which returns whether it changed anything), and write back ONLY
 *  when changed. Both the main allow-rule sync and the worktree approvals writer
 *  go through here, so the JSON merge + failure-open + malformed-skip + idempotent
 *  no-op semantics live in exactly one place. */
function mutateClaudeSettings(path: string, mutate: (settings: ClaudeSettings) => boolean): void {
  const settings = readClaudeSettingsAt(path);
  if (settings === null) return; // malformed — leave the file untouched
  if (!mutate(settings)) return; // nothing changed — byte-stable no-op
  writeClaudeSettingsAt(path, settings);
}

/**
 * HS-8376 / HS-8377 — add the `mcp__hotsheet-channel-<slug>__*` rule to
 * `.claude/settings.local.json`'s `permissions.allow` array. No-op when:
 * - `.claude/` is absent (user isn't using Claude Code in this project; §64.2 D4)
 * - the rule is already present (§64.2 D5 idempotence)
 * - `claude_auto_allow_rule: false` in `<dataDir>/settings.json` (§64.2 D7)
 * - the existing file is malformed JSON (§64.2 D6 failure-open; warning logged)
 *
 * When `.claude/` exists but `settings.local.json` doesn't, the file is
 * created with a minimal shape (§64.2 D3).
 *
 * Existing allow-array entries and every other top-level key are
 * preserved verbatim — the new rule is APPENDED, never sorted or
 * de-duped (§64.2 D5).
 */
export function syncClaudeAllowRule(dataDir: string): void {
  if (!existsSync(claudeDir(dataDir))) return;
  if (!isAutoAllowRuleEnabled(dataDir)) return;
  const rule = claudeAllowRulePattern(dataDir);
  mutateClaudeSettings(settingsLocalPath(dataDir), settings => {
    if (settings.permissions.allow.includes(rule)) return false;
    settings.permissions.allow = [...settings.permissions.allow, rule];
    return true;
  });
}

/**
 * HS-8376 / HS-8377 — symmetric remove. Drops the
 * `mcp__hotsheet-channel-<slug>__*` rule from `.claude/settings.local.json`'s
 * `permissions.allow` array. No-op when the file doesn't exist, the rule
 * isn't present, the file is malformed, or the per-project opt-out is on
 * (in which case Hot Sheet never wrote the rule in the first place — but
 * if a user toggles the setting on/off between register and unregister,
 * we still respect the current opt-out and leave hand-edits alone).
 *
 * Other allow-array entries and every other top-level key are preserved
 * verbatim.
 */
export function unsyncClaudeAllowRule(dataDir: string): void {
  const path = settingsLocalPath(dataDir);
  if (!existsSync(path)) return;
  if (!isAutoAllowRuleEnabled(dataDir)) return;
  const rule = claudeAllowRulePattern(dataDir);
  mutateClaudeSettings(path, settings => {
    if (!settings.permissions.allow.includes(rule)) return false;
    settings.permissions.allow = settings.permissions.allow.filter(r => r !== rule);
    return true;
  });
}

/**
 * HS-9058 (docs/104) — pre-approve a worker WORKTREE's channel MCP server +
 * worker skills by writing `<worktreeRoot>/.claude/settings.local.json`, so a
 * `claude "/hotsheet-worker"` agent in a fresh worktree doesn't stall on the
 * "Allow MCP server X?" + "Allow skill Y?" prompts (fatal for headless / auto-
 * scaled workers — nobody's there to click).
 *
 * Writes, merging into any existing file (preserve unrelated keys, idempotent):
 * - **`enabledMcpjsonServers += hotsheet-channel-<slug>`** — skips the
 *   per-server approval. `<slug>` = `getMcpServerKey(ownerDataDir)`.
 * - **`permissions.allow +=`** the `mcp__hotsheet-channel-<slug>__*` tool wildcard
 *   (the §104.2 bug fix — the owner-rooted `syncClaudeAllowRule` never reached
 *   worktrees, so even the `hotsheet_*` tool CALLS prompt today) AND a
 *   `Skill(<name>)` entry for each generated worker/category skill name.
 *
 * The worktree is a **follower** with no settings of its own, so the
 * `claude_auto_allow_rule` opt-out is read from the OWNER's `ownerDataDir`.
 * Failure-open + gated on the worktree actually using Claude Code (the
 * `.claude/` gate, which `createWorktree` satisfies by calling
 * `ensureSkillsForDir` first when a worker will run there).
 */
export function writeWorktreeApprovals(worktreeRoot: string, ownerDataDir: string, skillNames: string[]): void {
  // Only when the worktree actually uses Claude Code (mirrors the main path's
  // `.claude/` gate). `createWorktree` calls `ensureSkillsForDir` first, which
  // creates `.claude/` exactly when a worker will run there.
  if (!existsSync(join(worktreeRoot, '.claude'))) return;
  // Gated on the OWNER's opt-out — the worktree follower has no settings of its own.
  if (!isAutoAllowRuleEnabled(ownerDataDir)) return;
  const serverKey = getMcpServerKey(ownerDataDir);
  const allowRules = [
    claudeAllowRulePattern(ownerDataDir),
    ...skillNames.map(name => `Skill(${name})`),
  ];
  mutateClaudeSettings(settingsLocalPathForRoot(worktreeRoot), settings => {
    let changed = false;
    const servers = settings.enabledMcpjsonServers ?? [];
    if (!servers.includes(serverKey)) {
      settings.enabledMcpjsonServers = [...servers, serverKey];
      changed = true;
    }
    let allow = settings.permissions.allow;
    for (const rule of allowRules) {
      if (!allow.includes(rule)) {
        allow = [...allow, rule];
        changed = true;
      }
    }
    settings.permissions.allow = allow;
    return changed;
  });
}

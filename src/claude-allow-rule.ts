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
 * The two exported functions are called from `registerChannel` /
 * `unregisterChannel` (in `channel-config.ts`) so the allow rule stays in
 * lockstep with the `.mcp.json` entry — enabling the channel adds it,
 * disabling removes it.
 *
 * Design + decision rationale lives in `docs/64-claude-allow-rule.md`.
 */

/** Match the Claude-Code allow-array entries (`permissions.allow`) plus
 *  preserve every other key the user might have under `permissions` and at
 *  the top level. `.loose()` at both levels keeps the unrelated keys
 *  byte-stable across our read-mutate-write cycle. */
const ClaudeSettingsSchema = z.object({
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
 *  depend on a private function in another file. */
function projectRoot(dataDir: string): string {
  return dataDir.replace(/\/\.hotsheet\/?$/, '');
}

function claudeDir(dataDir: string): string {
  return join(projectRoot(dataDir), '.claude');
}

function settingsLocalPath(dataDir: string): string {
  return join(claudeDir(dataDir), 'settings.local.json');
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

/** Read + parse `.claude/settings.local.json`. Returns `null` on parse
 *  failure so the caller knows to abort without writing back a fresh
 *  shape over a user-intended-but-malformed file. Returns
 *  `{ permissions: { allow: [] } }` when the file is missing. */
function readClaudeSettings(dataDir: string): ClaudeSettings | null {
  const path = settingsLocalPath(dataDir);
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

/** Write `.claude/settings.local.json` with 2-space indent + trailing
 *  newline (matches Claude Code's own convention). Creates `.claude/` if
 *  it doesn't exist — but the public entry points only reach here after
 *  confirming `.claude/` already exists, so this is a defensive belt. */
function writeClaudeSettings(dataDir: string, settings: ClaudeSettings): void {
  const path = settingsLocalPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings, null, 2) + '\n', 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[claude-allow-rule] Failed to write ${path}: ${msg}; channel registration continues`);
  }
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
  const settings = readClaudeSettings(dataDir);
  if (settings === null) return;
  const rule = claudeAllowRulePattern(dataDir);
  if (settings.permissions.allow.includes(rule)) return;
  settings.permissions.allow = [...settings.permissions.allow, rule];
  writeClaudeSettings(dataDir, settings);
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
  const settings = readClaudeSettings(dataDir);
  if (settings === null) return;
  const rule = claudeAllowRulePattern(dataDir);
  if (!settings.permissions.allow.includes(rule)) return;
  settings.permissions.allow = settings.permissions.allow.filter(r => r !== rule);
  writeClaudeSettings(dataDir, settings);
}

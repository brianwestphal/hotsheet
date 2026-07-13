// HS-9346 — the ACP auto-allow gate: the §47 equivalent of the Claude channel's
// `permission_allow_rules` pre-emption (`routes/channel.ts::fetchPermissionFromPort` →
// `findMatchingAllowRule`). Before the overlay renders for an ACP
// `session/request_permission`, map the agent's `toolCall` onto a Claude-style
// `(tool, primary)` pair and check the project's allow-rules; on a match, the drive
// resolves with the allow option (`pickAllowOptionId`) so the popup never appears.
//
// The `toolCall.kind` → Claude-tool mapping is grounded in the LIVE OpenCode shapes
// (docs/114 §114.12): `execute` carries `rawInput.command` (== Claude Bash's `command`
// field), `edit` carries `rawInput.filepath`. `edit`/`write` are intentionally NOT
// gated — `findMatchingAllowRule` already refuses `Edit`/`Write` (§47.4.2: a file path
// alone doesn't capture diff intent), so an `edit` toolCall correctly always shows the
// popup. Pure (no IO) — the drive reads + parses `permission_allow_rules` and passes them in.

import { type AllowRule, findMatchingAllowRule } from '../permissionAllowRules.js';
import { type AcpPermissionOption, pickAllowOptionId } from './acpMapping.js';

/** An allow-listable ACP `kind` → the Claude tool name its rules are keyed by, plus
 *  which `rawInput` field (in order) holds the primary value. Non-listable kinds
 *  (`edit`/`delete`/`move`/`search`/`think`/`other`) are absent → never gated. */
const KIND_MAP: Readonly<Partial<Record<string, { tool: string; fields: readonly string[] }>>> = {
  execute: { tool: 'Bash', fields: ['command'] },
  read: { tool: 'Read', fields: ['filePath', 'filepath', 'file_path', 'path'] },
  fetch: { tool: 'WebFetch', fields: ['url'] },
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/** First field (in order) that holds a non-empty string, or null. */
function pickField(rec: Record<string, unknown>, fields: readonly string[]): string | null {
  for (const field of fields) {
    const v = rec[field];
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

/**
 * Map an ACP `toolCall` to the `(tool, primary)` pair the allow-rule matcher expects, or
 * null when the kind isn't allow-listable / no primary value is recoverable. The primary
 * comes from the mapped `rawInput` field, falling back to the toolCall `title` (for
 * `execute` the title IS the command, e.g. "git status").
 */
export function acpToolCallRuleTarget(toolCall: unknown): { tool: string; primary: string } | null {
  const tc = asRecord(toolCall);
  if (tc === null) return null;
  const kind = typeof tc.kind === 'string' ? tc.kind : '';
  const mapped = KIND_MAP[kind];
  if (mapped === undefined) return null;

  const rawInput = asRecord(tc.rawInput);
  const fromRaw = rawInput !== null ? pickField(rawInput, mapped.fields) : null;
  const title = typeof tc.title === 'string' && tc.title !== '' ? tc.title : null;
  const primary = fromRaw ?? title;
  if (primary === null) return null;
  return { tool: mapped.tool, primary };
}

/**
 * The allow option to auto-resolve with when a rule matches this toolCall, or null to
 * show the popup. A matched rule auto-allows ONCE (`remember=false`) — the rule itself is
 * the persistence, mirroring the Claude gate's single `allow` response.
 */
export function acpAutoAllowOptionId(
  toolCall: unknown,
  options: readonly AcpPermissionOption[],
  rules: AllowRule[],
): string | null {
  const target = acpToolCallRuleTarget(toolCall);
  if (target === null) return null;
  const rule = findMatchingAllowRule(target.tool, target.primary, rules);
  if (rule === null) return null;
  return pickAllowOptionId(options, false);
}

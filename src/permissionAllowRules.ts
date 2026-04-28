/**
 * HS-7952 / HS-6703 — per-project permission allow-rule matcher.
 *
 * The Hot Sheet permission popup ([12-claude-channel.md §12.10] / docs/47)
 * relays Claude's per-tool permission requests to the user. For repetitive
 * requests (`git status`, `git diff`, `npm test`) the user clicks Allow
 * every time and the popup is pure noise. This module gates that:
 * configured `permission_allow_rules` in `<dataDir>/settings.json` cause
 * matching requests to be auto-allowed before the long-poll wake fires
 * (so the popup never even renders).
 *
 * Exposes the pure matcher + the primary-field extractor; the server-side
 * wire-up that calls these lives in `src/routes/channel.ts::fetchPermission`.
 *
 * **Edit / Write deliberately not allow-listable** — file path alone
 * doesn't capture diff intent (§47.4.2). Rules with `tool === 'Edit'` or
 * `'Write'` are silently skipped by the matcher.
 */

export interface AllowRule {
  /** Stable id (caller-generated, e.g. ULID) for delete + audit. */
  id: string;
  /** Exact-match tool name (e.g. `Bash`, `Read`, `Glob`). Case-sensitive
   *  — Claude's tool names are stable proper nouns. */
  tool: string;
  /** JavaScript regex source. Auto-anchored at match time via `^...$` so
   *  user-entered `git status` matches `git status` exactly, not
   *  `cd /tmp && git status`. */
  pattern: string;
  /** ISO timestamp when the rule was created (display only). */
  added_at: string;
  /** `'overlay'` if added via the popup shortcut, `'settings'` if via the
   *  management page. Lets future telemetry distinguish quick-shortcut
   *  rules from deliberate ones. */
  added_by?: 'overlay' | 'settings';
}

/**
 * Pure: which input field is the "primary" matchable value for each tool.
 * Bash → command, Read → file_path, etc. Returns null for tools we don't
 * support allow-listing (the matcher skips them). Mirrors the same map in
 * `src/client/permissionPreview.ts::primaryFieldKey` — kept here to avoid
 * pulling client code into server imports.
 */
export function primaryFieldKey(toolName: string): string | null {
  switch (toolName) {
    case 'Bash':         return 'command';
    case 'WebFetch':     return 'url';
    case 'WebSearch':    return 'query';
    case 'Glob':         return 'pattern';
    case 'Read':
    case 'NotebookRead': return 'file_path';
    default:             return null;
  }
}

/**
 * Pure: extract the primary field value from a Claude `input_preview` JSON
 * blob. Returns null when the tool isn't allow-listable, the JSON is
 * malformed, OR the primary field is missing / non-string.
 */
export function extractPrimaryValue(toolName: string, inputPreview: string): string | null {
  const key = primaryFieldKey(toolName);
  if (key === null) return null;
  if (inputPreview === '') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(inputPreview); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const value = (parsed as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Pure: tolerantly parse the `permission_allow_rules` settings value into
 * a list of `AllowRule`. Accepts the raw array OR the legacy stringified-
 * JSON form. Drops malformed entries (missing required fields, wrong
 * types) silently. Returns `[]` for any unrecoverable input.
 */
export function parseAllowRules(raw: unknown): AllowRule[] {
  let value: unknown = raw;
  if (typeof value === 'string' && value !== '') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const out: AllowRule[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Partial<AllowRule>;
    if (typeof obj.id !== 'string' || obj.id === '') continue;
    if (typeof obj.tool !== 'string' || obj.tool === '') continue;
    if (typeof obj.pattern !== 'string') continue;
    const added_at = typeof obj.added_at === 'string' ? obj.added_at : '';
    const added_by = obj.added_by === 'overlay' || obj.added_by === 'settings'
      ? obj.added_by
      : undefined;
    out.push({ id: obj.id, tool: obj.tool, pattern: obj.pattern, added_at, added_by });
  }
  return out;
}

/**
 * Pure: find the first matching allow-rule for a `(tool, primary)` pair.
 * Returns null when no rule matches. Skips Edit / Write entirely (per
 * §47.4.2 — file path alone doesn't capture diff intent). Skips rules with
 * malformed regex (logs the failure; doesn't crash). Anchors patterns
 * with `^...$` so user-entered `git status` matches `git status` exactly.
 *
 * Defensive against catastrophic backtracking: skips rules whose pattern
 * exceeds `MAX_PATTERN_LENGTH` characters (a heuristic that catches
 * pathological inputs without paying for a proper timeout).
 */
const MAX_PATTERN_LENGTH = 500;

export function findMatchingAllowRule(toolName: string, primary: string, rules: AllowRule[]): AllowRule | null {
  if (toolName === 'Edit' || toolName === 'Write') return null;
  for (const rule of rules) {
    if (rule.tool !== toolName) continue;
    if (rule.pattern.length > MAX_PATTERN_LENGTH) continue;
    let regex: RegExp;
    try {
      regex = new RegExp(`^(?:${rule.pattern})$`);
    } catch {
      // Malformed regex — skip this rule. The settings UI's dry-run
      // affordance is the user's first line of defense; bad regexes that
      // sneak through are silently no-ops here rather than crashing the
      // gate.
      continue;
    }
    if (regex.test(primary)) return rule;
  }
  return null;
}

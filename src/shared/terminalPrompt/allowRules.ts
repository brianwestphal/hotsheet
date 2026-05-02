/**
 * HS-7987 Phase 3 — pure helpers for terminal-prompt allow rules.
 *
 * Settings live in `<dataDir>/settings.json` under `terminal_prompt_allow_rules`
 * (added to `JSON_VALUE_KEYS` in `src/file-settings.ts`). Mirrors the §47.4
 * `permission_allow_rules` precedent: per-project, file-based, manageable
 * by hand-editing settings.json if needed.
 *
 * Generic-fallback responses are NEVER allow-listable — see
 * docs/52-terminal-prompt-overlay.md §52.1 for the rationale (free-text
 * replies are too high-risk to auto-respond).
 */
import { buildNumberedPayload, buildYesNoPayload, type MatchResult } from './parsers.js';

export interface TerminalPromptAllowRule {
  /** Stable id (caller-generated, e.g. ULID). */
  id: string;
  /** Parser that fired (`claude-numbered` | `yesno`). Never `generic`. */
  parser_id: string;
  /** djb2 hash of the lowercase-trimmed question text. Stable across cosmetic
   *  whitespace changes; collisions accepted as an audit-trail risk. */
  question_hash: string;
  /** First ~120 chars of the original question text — used by Phase 4's
   *  Settings UI to show the user what the rule matches. Optional for back-
   *  compat; rules created before HS-7988 won't have one. */
  question_preview?: string;
  /** 0-based choice index that was selected (numbered) OR 0 for `yes` and 1
   *  for `no` on the yesno shape. */
  choice_index: number;
  /** Human-readable choice label ("Continue" / "Yes" / "1. Foo") — used by
   *  Phase 4's Settings UI for the same reason as `question_preview`. */
  choice_label?: string;
  /**
   * HS-8071 — pipe-joined, lowercase-trimmed labels of every choice in the
   * prompt (numbered shape) or the literal `yes|no` (yesno shape). Acts as
   * a drift-resistant secondary fingerprint: when Claude TUI status-bar
   * lines bleed into the captured question region, the `question_hash`
   * shifts but the choice labels stay stable across renders, so a
   * `(parser_id, choice_shape)` lookup still recognises the prompt and
   * auto-allows. Optional for back-compat — rules created before the fix
   * still match on `question_hash` only.
   */
  choice_shape?: string;
  /** ISO timestamp when the rule was created (display only). */
  created_at: string;
}

/**
 * Pure: tolerantly parse the `terminal_prompt_allow_rules` settings value
 * into a list of `TerminalPromptAllowRule`. Accepts the raw array OR the
 * legacy stringified-JSON form. Drops malformed entries silently. Returns
 * `[]` for any unrecoverable input.
 *
 * HS-8061 — collapses duplicate `(parser_id, question_hash, choice_index)`
 * entries down to the FIRST occurrence (preserving insertion order so the
 * created_at / id of the original allow click stays stable). Pre-fix
 * `appendAllowRule` had no dedupe gate, so a user who clicked "Always
 * allow" multiple times on the same prompt (e.g. several Claude
 * instances hitting the same WARNING on launch) ended up with 10+
 * identical rows in the Settings → Terminal-prompts list. The dedupe
 * here makes the bloated state cosmetically harmless even before the
 * file gets rewritten by the next `appendAllowRule` (which now writes
 * back the deduped list).
 */
export function parseAllowRules(raw: unknown): TerminalPromptAllowRule[] {
  let value: unknown = raw;
  if (typeof value === 'string' && value !== '') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const out: TerminalPromptAllowRule[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Partial<TerminalPromptAllowRule>;
    if (typeof obj.id !== 'string' || obj.id === '') continue;
    if (typeof obj.parser_id !== 'string' || obj.parser_id === '') continue;
    if (typeof obj.question_hash !== 'string' || obj.question_hash === '') continue;
    if (typeof obj.choice_index !== 'number' || !Number.isFinite(obj.choice_index)) continue;
    const dupKey = `${obj.parser_id}\x00${obj.question_hash}\x00${obj.choice_index}`;
    if (seen.has(dupKey)) continue;
    seen.add(dupKey);
    const created_at = typeof obj.created_at === 'string' ? obj.created_at : '';
    const rule: TerminalPromptAllowRule = {
      id: obj.id,
      parser_id: obj.parser_id,
      question_hash: obj.question_hash,
      choice_index: obj.choice_index,
      created_at,
    };
    if (typeof obj.question_preview === 'string') rule.question_preview = obj.question_preview;
    if (typeof obj.choice_label === 'string') rule.choice_label = obj.choice_label;
    if (typeof obj.choice_shape === 'string' && obj.choice_shape !== '') rule.choice_shape = obj.choice_shape;
    out.push(rule);
  }
  return out;
}

/**
 * Pure: find the rule that matches the given `MatchResult`. Two-tier lookup
 * (HS-8071):
 *
 * 1. **Primary** — `(parser_id, question_hash)` exact match. Same as the
 *    pre-fix behaviour. Stable for prompts whose surrounding TUI doesn't
 *    contaminate the captured question region.
 * 2. **Drift-resistant fallback** — `(parser_id, choice_shape)` exact match.
 *    The `choice_shape` is computed deterministically from the prompt's
 *    visible choices (numbered: pipe-joined lowercase-trimmed labels;
 *    yesno: the literal `yes|no`), so it stays stable even when Claude
 *    TUI status-bar lines bleed into the question region and the
 *    `question_hash` shifts. Only kicks in for rules created after the
 *    HS-8071 fix (older rules don't carry `choice_shape` and skip this
 *    branch).
 *
 * Returns null when the match's shape is `generic` (never allow-listable
 * — see docs/52 §52.1) or when no rule matches under either tier.
 */
export function findMatchingAllowRule(
  match: MatchResult,
  rules: readonly TerminalPromptAllowRule[],
): TerminalPromptAllowRule | null {
  if (match.shape === 'generic') return null;
  const parts = match.signature.split(':');
  if (parts.length < 3) return null;
  const parserId = parts[0];
  const questionHash = parts[1];
  const matchShape = buildChoiceShape(match);
  // Tier 1 — primary `(parser_id, question_hash)` lookup.
  for (const rule of rules) {
    if (rule.parser_id !== parserId) continue;
    if (rule.question_hash !== questionHash) continue;
    return rule;
  }
  // Tier 2 — drift-resistant `(parser_id, choice_shape)` fallback. Skipped
  // when the match has no usable shape (defensive — empty shapes match too
  // broadly) or when no rule was recorded with a `choice_shape`.
  if (matchShape !== '') {
    for (const rule of rules) {
      if (rule.parser_id !== parserId) continue;
      if (rule.choice_shape === undefined || rule.choice_shape === '') continue;
      if (rule.choice_shape !== matchShape) continue;
      return rule;
    }
  }
  return null;
}

/**
 * HS-8071 — pure: derive a stable choice-shape fingerprint from a match.
 * Numbered shape: pipe-joined, lowercase-trimmed choice labels in the
 * order Claude rendered them (`"i am using this for local development|exit"`).
 * Yesno shape: literal `"yes|no"` regardless of capitalisation, since the
 * shape is invariant. Generic shape: empty string (never allow-listable).
 *
 * Exported so the always-allow-builder + the auto-allow gate share one
 * canonical implementation, and so the test suite can pin the expected
 * values directly.
 */
export function buildChoiceShape(match: MatchResult): string {
  if (match.shape === 'numbered') {
    return match.choices.map(c => c.label.trim().toLowerCase()).join('|');
  }
  if (match.shape === 'yesno') return 'yes|no';
  return '';
}

/**
 * Pure: build a freshly-minted allow rule for a (match, chosenIndex,
 * chosenLabel) triple. Throws when called with a generic-fallback match,
 * since generic rules are explicitly disallowed. The id uses a millisecond
 * timestamp + 6 random hex chars — stable enough for a delete affordance,
 * not cryptographic.
 */
export function buildAllowRule(
  match: MatchResult,
  choiceIndex: number,
  choiceLabel: string,
): TerminalPromptAllowRule {
  if (match.shape === 'generic') {
    throw new Error('Cannot build an allow rule for a generic-fallback prompt — see docs/52 §52.1');
  }
  const parts = match.signature.split(':');
  const parserId = parts[0];
  const questionHash = parts[1];
  const id = newRuleId();
  const preview = match.question.slice(0, 120);
  // HS-8071 — record the drift-resistant `choice_shape` fingerprint so the
  // auto-allow gate can fall back to it when Claude's question_hash
  // shifts under TUI status-bar contamination.
  const choiceShape = buildChoiceShape(match);
  return {
    id,
    parser_id: parserId,
    question_hash: questionHash,
    question_preview: preview,
    choice_index: choiceIndex,
    choice_label: choiceLabel,
    choice_shape: choiceShape !== '' ? choiceShape : undefined,
    created_at: new Date().toISOString(),
  };
}

function newRuleId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `tp_${ts}_${rand}`;
}

/**
 * Pure: derive the keystroke payload to send for an auto-allowed rule.
 * Returns null when the rule's choice index is out of range (e.g. the
 * Claude prompt now has fewer choices than when the rule was created — the
 * caller should fall back to surfacing the overlay so the user can see
 * what's going on). Generic-shape matches never auto-allow.
 *
 * Moved from `src/client/terminalPrompt/autoAllow.ts` to shared/ in
 * HS-8034 Phase 2 so the server-side scanner gate (`registry.ts`) and the
 * client-side path (until Phase 2 finishes deleting it) share one
 * canonical source. Identical behaviour to the prior client-only
 * implementation.
 */
export function payloadForAutoAllow(match: MatchResult, rule: TerminalPromptAllowRule): string | null {
  if (match.shape === 'numbered') {
    if (rule.choice_index < 0) return null;
    if (rule.choice_index >= match.choices.length) return null;
    return buildNumberedPayload(match.choices, rule.choice_index);
  }
  if (match.shape === 'yesno') {
    const choice: 'yes' | 'no' = rule.choice_index === 0 ? 'yes' : 'no';
    return buildYesNoPayload(match, choice);
  }
  // generic shape never auto-allows.
  return null;
}

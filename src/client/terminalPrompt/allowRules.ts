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
import type { MatchResult } from './parsers.js';

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
  /** ISO timestamp when the rule was created (display only). */
  created_at: string;
}

/**
 * Pure: tolerantly parse the `terminal_prompt_allow_rules` settings value
 * into a list of `TerminalPromptAllowRule`. Accepts the raw array OR the
 * legacy stringified-JSON form. Drops malformed entries silently. Returns
 * `[]` for any unrecoverable input.
 */
export function parseAllowRules(raw: unknown): TerminalPromptAllowRule[] {
  let value: unknown = raw;
  if (typeof value === 'string' && value !== '') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  if (!Array.isArray(value)) return [];
  const out: TerminalPromptAllowRule[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Partial<TerminalPromptAllowRule>;
    if (typeof obj.id !== 'string' || obj.id === '') continue;
    if (typeof obj.parser_id !== 'string' || obj.parser_id === '') continue;
    if (typeof obj.question_hash !== 'string' || obj.question_hash === '') continue;
    if (typeof obj.choice_index !== 'number' || !Number.isFinite(obj.choice_index)) continue;
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
    out.push(rule);
  }
  return out;
}

/**
 * Pure: find the rule that matches `(parser_id, question_hash, choice_index)`
 * for the given `MatchResult`. Returns null when the match's shape is
 * `generic` (not allow-listable) OR when no rule matches.
 *
 * Uses the `signature` field on `MatchResult` (already shaped as
 * `parser_id:question_hash:default_choice_index`) for the hash extraction —
 * rules can specify ANY choice index, not just the default, so we
 * deconstruct the signature and pair-up parser_id + question_hash.
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
  for (const rule of rules) {
    if (rule.parser_id !== parserId) continue;
    if (rule.question_hash !== questionHash) continue;
    // choice_index match is part of the rule, not the match — a single
    // (parser_id, question_hash) pair could have multiple rules per choice.
    return rule;
  }
  return null;
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
  return {
    id,
    parser_id: parserId,
    question_hash: questionHash,
    question_preview: preview,
    choice_index: choiceIndex,
    choice_label: choiceLabel,
    created_at: new Date().toISOString(),
  };
}

function newRuleId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `tp_${ts}_${rand}`;
}

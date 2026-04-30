/**
 * HS-7987 Phase 3 — auto-allow gate.
 *
 * Shared by both prompt-detector callsites (drawer in `terminal.tsx`,
 * dedicated view in `terminalTileGrid.tsx`). When a parser fires, this
 * helper checks the configured allow-rules; on match it writes the rule's
 * choice payload directly to the PTY, posts an audit-log entry, and tells
 * the caller "skip the overlay". On no match the caller mounts the
 * overlay normally.
 *
 * Audit POSTs are fire-and-forget — a network blip during the audit
 * shouldn't block the actual response (which is the point of the gate).
 */
import { api } from '../api.js';
import { findMatchingAllowRule, type TerminalPromptAllowRule } from './allowRules.js';
import { getAllowRules } from './allowRulesStore.js';
import {
  buildNumberedPayload,
  buildYesNoPayload,
  type ChoiceOption,
  type MatchResult,
} from '../../shared/terminalPrompt/parsers.js';

export interface AutoAllowResult {
  /** True when a rule matched and the payload was sent. Caller should NOT
   *  open the overlay in this case. */
  applied: boolean;
}

export interface TryAutoAllowOptions {
  match: MatchResult;
  /** Caller writes the payload to its PTY's WebSocket. Returning false
   *  means the WebSocket was dead — auto-allow falls back to the overlay
   *  so the user can see the failure. */
  send: (payload: string) => boolean;
}

/**
 * Run the gate. Returns `{applied: true}` only when a matching rule was
 * found AND the payload was successfully written to the WebSocket. Any
 * other path (no rule, generic shape, dropped WS, build-payload error)
 * returns `{applied: false}` so the caller mounts the overlay normally.
 */
export function tryAutoAllow(opts: TryAutoAllowOptions): AutoAllowResult {
  const rules = getAllowRules();
  if (rules.length === 0) return { applied: false };
  const rule = findMatchingAllowRule(opts.match, rules);
  if (rule === null) return { applied: false };
  const payload = payloadForAutoAllow(opts.match, rule);
  if (payload === null) return { applied: false };
  const ok = opts.send(payload);
  if (!ok) return { applied: false };
  // Fire-and-forget audit log — server tolerates network failure
  // gracefully; the response has already been sent so the user sees the
  // expected behaviour either way.
  void postAuditEntry(opts.match, rule);
  return { applied: true };
}

/**
 * Pure: derive the keystroke payload to send for an auto-allowed rule.
 * Returns null when the rule's choice index is out of range (e.g. the
 * Claude prompt now has fewer choices than when the rule was created —
 * skip the gate and let the user see the overlay).
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

/** POST the audit entry. Swallows errors — the audit is best-effort. */
async function postAuditEntry(match: MatchResult, rule: TerminalPromptAllowRule): Promise<void> {
  try {
    await api('/terminal-prompt/audit', {
      method: 'POST',
      body: {
        parser_id: match.parserId,
        question: match.question,
        choice_label: rule.choice_label ?? `choice_index=${rule.choice_index}`,
        rule_id: rule.id,
      },
    });
  } catch {
    /* swallow — audit is best-effort */
  }
}

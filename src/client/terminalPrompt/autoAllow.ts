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
import {
  findMatchingAllowRule,
  payloadForAutoAllow,
  type TerminalPromptAllowRule,
} from '../../shared/terminalPrompt/allowRules.js';
import type { MatchResult } from '../../shared/terminalPrompt/parsers.js';
import { api } from '../api.js';
import { getAllowRules } from './allowRulesStore.js';

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

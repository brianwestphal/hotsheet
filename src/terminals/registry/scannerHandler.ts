import { addLogEntry } from '../../db/queries.js';
import { instrumentSync } from '../../diagnostics/freezeLogger.js';
import { readFileSettings } from '../../file-settings.js';
import {
  findMatchingAllowRule,
  parseAllowRules,
  payloadForAutoAllow,
  type TerminalPromptAllowRule,
} from '../../shared/terminalPrompt/allowRules.js';
import type { MatchResult } from '../../shared/terminalPrompt/parsers.js';
import type { SessionState } from './types.js';

/**
 * HS-8189 — auto-allow gate + scanner-match handling for the terminals
 * registry. Pre-fix this lived inline in `src/terminals/registry.ts` next
 * to `createSession` and `restartTerminal`. Keeping it in its own module
 * makes it testable in isolation and unhooks the gate from the storage
 * layer (`sessionStore.ts`) — the only registry-internal coupling left
 * is the `SessionState` field shape from `types.ts`.
 */

/**
 * HS-8034 Phase 2 — server-side auto-allow gate. Called from the scanner's
 * `onMatch` closure for every fresh match. If the project has a
 * `terminal_prompt_allow_rules` entry that matches the prompt's
 * `(parser_id, question_hash)` pair, the response payload is sent
 * directly to the PTY and an audit-log entry is appended; `pendingPrompt`
 * stays null so no overlay surfaces. Otherwise the match is stashed on
 * `state.pendingPrompt` for the long-poll surface to pick up + the
 * registered prompt-waiters fire so any client waiting in
 * `/api/projects/bell-state` sees the new prompt without waiting for the
 * long-poll timeout.
 */
export function handleScannerMatch(
  state: SessionState,
  secret: string,
  dataDir: string,
  match: MatchResult,
): void {
  const rule = findMatchingRuleForProject(dataDir, match);
  if (rule !== null && state.pty !== null) {
    const payload = payloadForAutoAllow(match, rule);
    if (payload !== null) {
      // HS-8160 — wrap the auto-allow injection pty.write so a stalled
      // PTY shows up in freeze.log tagged `pty.write:auto-allow:<id>`.
      try {
        instrumentSync(dataDir, `pty.write:auto-allow:${state.terminalId}`, () => {
          state.pty!.write(payload);
        });
      } catch { /* PTY died mid-match */ }
      // Fire-and-forget audit log — best-effort, mirrors HS-7987's client
      // behaviour. The DB write happens off-event-loop.
      void appendAutoAllowAuditEntry(match, rule).catch(() => { /* ignore */ });
      // Auto-allow handled — leave pendingPrompt null so no overlay surfaces.
      return;
    }
  }
  state.pendingPrompt = match;
  notifyPromptWaiters(secret, state.terminalId);
}

function findMatchingRuleForProject(dataDir: string, match: MatchResult): TerminalPromptAllowRule | null {
  try {
    const settings = readFileSettings(dataDir);
    const raw = settings.terminal_prompt_allow_rules;
    if (raw === undefined || raw === null) return null;
    const rules = parseAllowRules(raw);
    if (rules.length === 0) return null;
    return findMatchingAllowRule(match, rules);
  } catch {
    return null;
  }
}

/**
 * HS-8210 (§58.8) — pure helper that builds the `summary` + `detail`
 * strings written to the command log when an auto-allow fires. Channel-
 * keyed rules carry `(channel <match_channel>)` in the summary suffix
 * (and a `Channel:` line in the detail) so the user can filter the
 * command log by channel and tell at a glance which auto-allows fired
 * via Tier 0 vs the legacy hash / preview / label tiers.
 */
export function buildAutoAllowAuditStrings(match: MatchResult, rule: TerminalPromptAllowRule): { summary: string; detail: string } {
  const choiceLabel = rule.choice_label ?? `choice_index=${rule.choice_index}`;
  const channelSuffix = rule.match_channel !== undefined
    ? ` (channel ${rule.match_channel})`
    : ` (rule ${rule.id})`;
  const summary = `Terminal prompt: ${match.parserId} → ${choiceLabel.slice(0, 80)} — Auto-allowed${channelSuffix}`.slice(0, 200);
  const detail = `Question: ${match.question}\nChoice: ${choiceLabel}\nParser: ${match.parserId}\nRule: ${rule.id}${rule.match_channel !== undefined ? `\nChannel: ${rule.match_channel}` : ''}`.slice(0, 4000);
  return { summary, detail };
}

async function appendAutoAllowAuditEntry(match: MatchResult, rule: TerminalPromptAllowRule): Promise<void> {
  const { summary, detail } = buildAutoAllowAuditStrings(match, rule);
  await addLogEntry('terminal_prompt_auto_allow', 'incoming', summary, detail);
}

/**
 * HS-8034 Phase 2 — long-pollers waiting on `/api/projects/bell-state`
 * subscribe via `notifyBellWaiters` from `routes/notify.ts`. Prompt
 * matches share the same wake mechanism so a fresh `pendingPrompt` is
 * surfaced immediately instead of waiting for the long-poll timeout.
 *
 * Lazy dynamic import keeps registry → routes/notify out of the import
 * cycle (mirrors the existing bell-state notify path).
 */
function notifyPromptWaiters(_secret: string, _terminalId: string): void {
  void import('../../routes/notify.js')
    .then(m => m.notifyBellWaiters())
    .catch(() => { /* no waiters / module load issue — survive */ });
}

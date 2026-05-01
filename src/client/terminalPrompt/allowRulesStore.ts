/**
 * HS-7987 Phase 3 — async store + cache for `terminal_prompt_allow_rules`.
 *
 * Hydrates from `/file-settings` on first read; subsequent reads are
 * synchronous so the detector's auto-allow gate doesn't have to await
 * settings on every chunk. Writes go straight through to settings via
 * PATCH `/file-settings`.
 *
 * Subscribers (Phase 4 Settings UI) can register a callback via
 * `subscribeToAllowRules` to re-render when the rule list changes.
 */
import { parseAllowRules, type TerminalPromptAllowRule } from '../../shared/terminalPrompt/allowRules.js';
import { api, apiWithSecret } from '../api.js';

let cachedRules: TerminalPromptAllowRule[] = [];
let hydrated = false;
let hydratePromise: Promise<TerminalPromptAllowRule[]> | null = null;
const subscribers = new Set<(rules: TerminalPromptAllowRule[]) => void>();

interface FileSettingsShape {
  terminal_prompt_allow_rules?: unknown;
}

/** Force a fresh fetch from the server. Returns the new rule list. */
export async function loadAllowRules(): Promise<TerminalPromptAllowRule[]> {
  const fs = await api<FileSettingsShape>('/file-settings');
  cachedRules = parseAllowRules(fs.terminal_prompt_allow_rules);
  hydrated = true;
  notifySubscribers();
  return cachedRules;
}

/**
 * Synchronous read. If the cache hasn't been hydrated yet, kicks off a
 * hydration in the background and returns the empty list — the caller
 * (the detector) treats "no rules yet" as the default-deny path, which is
 * the safe fallback while we wait for the first fetch.
 */
export function getAllowRules(): readonly TerminalPromptAllowRule[] {
  if (!hydrated && hydratePromise === null) {
    hydratePromise = loadAllowRules().catch(() => {
      // Failure leaves the cache empty; next call will retry.
      hydratePromise = null;
      return [];
    });
  }
  return cachedRules;
}

/** Append a rule to settings.json + the in-memory cache. Notifies
 *  subscribers. Resolves on success; throws on PATCH failure (caller can
 *  surface the error inline in the overlay).
 *
 *  HS-8057: when `secret` is provided the write targets THAT project's
 *  settings.json (cross-project allow-list flow from `bellPoll.tsx` —
 *  the user clicked "Always choose this" on a prompt surfaced from a
 *  project other than the active one, so the rule must persist into the
 *  originating project's settings, not the active project's). The global
 *  in-memory cache + subscribers only track the active project's rules,
 *  so the secret-targeted path skips the cache update entirely; the
 *  Settings UI for the originating project re-hydrates on next open.
 *
 *  HS-8061: dedupe by `(parser_id, question_hash, choice_index)` against
 *  the existing rule list before appending. Pre-fix every "Always allow"
 *  click appended unconditionally — when several Claude instances hit
 *  the same WARNING prompt simultaneously on launch (or the prompt
 *  re-surfaced before the rule write fully propagated to the
 *  server-side scanner gate), the user clicked allow on each repeat and
 *  every click added a duplicate row. The Settings → Terminal-prompts
 *  list ended up showing N identical rows. The match key here is the
 *  same shape `findMatchingAllowRule` uses server-side, so a duplicate
 *  add is a no-op for both UI display and auto-allow behaviour. */
export async function appendAllowRule(
  rule: TerminalPromptAllowRule,
  secret?: string,
): Promise<void> {
  // Read current rules to avoid clobbering a concurrent write from another
  // tab. `/file-settings` PATCH replaces the whole `terminal_prompt_allow_rules`
  // value, so we have to merge.
  const get = secret !== undefined
    ? apiWithSecret<FileSettingsShape>('/file-settings', secret)
    : api<FileSettingsShape>('/file-settings');
  const fs = await get;
  // `parseAllowRules` itself collapses duplicate
  // `(parser_id, question_hash, choice_index)` entries (HS-8061), so
  // `existing` is already a clean list even if the on-disk file holds
  // historical bloat from before the dedupe fix.
  const existing = parseAllowRules(fs.terminal_prompt_allow_rules);
  // HS-8061 dedupe — if the new rule duplicates an existing one, write
  // the cleaned `existing` list back so any historical duplicates that
  // were collapsed by `parseAllowRules` get rewritten to the file (not
  // strictly required since reads dedupe transparently, but rewriting
  // means a user who manually inspects settings.json sees the cleaned
  // shape after their next "Always allow" click).
  const isDuplicate = existing.some(r =>
    r.parser_id === rule.parser_id
    && r.question_hash === rule.question_hash
    && r.choice_index === rule.choice_index,
  );
  const next = isDuplicate ? existing : [...existing, rule];
  if (secret !== undefined) {
    await apiWithSecret('/file-settings', secret, {
      method: 'PATCH',
      body: { terminal_prompt_allow_rules: next },
    });
    return;
  }
  await api('/file-settings', {
    method: 'PATCH',
    body: { terminal_prompt_allow_rules: next },
  });
  cachedRules = next;
  hydrated = true;
  notifySubscribers();
}

/** Remove a rule by id. Used by the Phase 4 Settings UI's delete button.
 *
 *  HS-8057: same secret-routing semantics as `appendAllowRule` so a
 *  hypothetical cross-project removal flow targets the right settings
 *  file. Settings UI today only deletes rules in the active project so
 *  the parameter is unused in tree but kept for symmetry. */
export async function removeAllowRule(id: string, secret?: string): Promise<void> {
  const get = secret !== undefined
    ? apiWithSecret<FileSettingsShape>('/file-settings', secret)
    : api<FileSettingsShape>('/file-settings');
  const fs = await get;
  const existing = parseAllowRules(fs.terminal_prompt_allow_rules);
  const next = existing.filter(r => r.id !== id);
  if (secret !== undefined) {
    await apiWithSecret('/file-settings', secret, {
      method: 'PATCH',
      body: { terminal_prompt_allow_rules: next },
    });
    return;
  }
  await api('/file-settings', {
    method: 'PATCH',
    body: { terminal_prompt_allow_rules: next },
  });
  cachedRules = next;
  hydrated = true;
  notifySubscribers();
}

/** Subscribe to rule-list changes. Returns an unsubscribe function. */
export function subscribeToAllowRules(cb: (rules: TerminalPromptAllowRule[]) => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

function notifySubscribers(): void {
  for (const cb of subscribers) {
    try { cb(cachedRules); } catch { /* swallow */ }
  }
}

/** Test-only — reset the module state so tests don't leak between cases. */
export function __resetAllowRulesCacheForTests(): void {
  cachedRules = [];
  hydrated = false;
  hydratePromise = null;
  subscribers.clear();
}

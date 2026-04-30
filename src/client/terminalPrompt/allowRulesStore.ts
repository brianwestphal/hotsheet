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
import { api } from '../api.js';
import { parseAllowRules, type TerminalPromptAllowRule } from '../../shared/terminalPrompt/allowRules.js';

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
 *  surface the error inline in the overlay). */
export async function appendAllowRule(rule: TerminalPromptAllowRule): Promise<void> {
  // Read current rules to avoid clobbering a concurrent write from another
  // tab. `/file-settings` PATCH replaces the whole `terminal_prompt_allow_rules`
  // value, so we have to merge.
  const fs = await api<FileSettingsShape>('/file-settings');
  const existing = parseAllowRules(fs.terminal_prompt_allow_rules);
  const next = [...existing, rule];
  await api('/file-settings', {
    method: 'PATCH',
    body: { terminal_prompt_allow_rules: next },
  });
  cachedRules = next;
  hydrated = true;
  notifySubscribers();
}

/** Remove a rule by id. Used by the Phase 4 Settings UI's delete button. */
export async function removeAllowRule(id: string): Promise<void> {
  const fs = await api<FileSettingsShape>('/file-settings');
  const existing = parseAllowRules(fs.terminal_prompt_allow_rules);
  const next = existing.filter(r => r.id !== id);
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

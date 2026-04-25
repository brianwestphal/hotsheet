/**
 * HS-7825 — persistence layer for the configured-terminal hidden state
 * shared by the global Terminal Dashboard (§25) and the drawer terminal
 * grid (§36). See docs/38-terminal-visibility.md.
 *
 * Wraps the in-memory module (`dashboardHiddenTerminals.ts`) so the rest
 * of the codebase can keep using `setTerminalHidden` / `unhideAllInProject`
 * verbatim — the persistence layer subscribes to changes and fires a
 * debounced PATCH per project to write the configured-id subset of the
 * project's hidden set to `.hotsheet/settings.json` under the
 * `hidden_terminals` key.
 *
 * Dynamic terminals (`dyn-*` ids) are intentionally NOT persisted — their
 * lifetime is per-session, so persisting their hidden state would mean
 * stale ids accumulating in settings.json forever. The filter happens both
 * on read (`hydratePersistedHiddenForProject` skips them) and on write
 * (`computePersistedIds` strips them).
 *
 * Initial hydration runs once at app boot (`initPersistedHiddenTerminals`)
 * by fetching every registered project's `/file-settings` and seeding the
 * in-memory map. Subsequent toggles are written back via the change
 * subscription.
 */

import { apiWithSecret } from './api.js';
import {
  getHiddenTerminals,
  hydratePersistedHiddenForProject,
  isConfiguredTerminalId,
  subscribeToHiddenChanges,
} from './dashboardHiddenTerminals.js';
import type { ProjectInfo } from './state.js';

// Per-project debounced write timers. Keyed by project secret.
const writeTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Last-written value per project so we can short-circuit no-op writes.
const lastPersisted = new Map<string, string>();

const DEBOUNCE_MS = 250;

let subscriptionUnsub: (() => void) | null = null;
let knownSecrets: ReadonlySet<string> = new Set();

/**
 * Filter a project's full hidden-terminal set down to the subset that
 * should be persisted. Pure: input is the full set including dynamic ids,
 * output is the configured-only sorted list (sort stabilises serialised
 * order so unchanged sets produce byte-identical JSON, dodging spurious
 * file-mtime churn).
 */
export function computePersistedIds(allHidden: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const id of allHidden) if (isConfiguredTerminalId(id)) out.push(id);
  out.sort();
  return out;
}

function scheduleWrite(secret: string): void {
  const existing = writeTimers.get(secret);
  if (existing !== undefined) clearTimeout(existing);
  writeTimers.set(secret, setTimeout(() => {
    writeTimers.delete(secret);
    void writeNow(secret);
  }, DEBOUNCE_MS));
}

async function writeNow(secret: string): Promise<void> {
  const ids = computePersistedIds(getHiddenTerminals(secret));
  const serialised = JSON.stringify(ids);
  if (lastPersisted.get(secret) === serialised) return; // no-op
  lastPersisted.set(secret, serialised);
  try {
    await apiWithSecret(secret, '/file-settings', {
      method: 'PATCH',
      body: { hidden_terminals: ids },
    });
  } catch {
    // Best-effort. The change is still in memory; next toggle will
    // schedule another write attempt.
  }
}

/**
 * Initialise the persistence layer: fetch each known project's
 * `/file-settings.hidden_terminals` to seed the in-memory map, then
 * subscribe to subsequent changes to write them back.
 *
 * Idempotent — the second call replaces the project list (a project was
 * registered / unregistered) and re-seeds for newly known projects.
 * The change subscription is attached only once.
 */
export async function initPersistedHiddenTerminals(projects: ProjectInfo[]): Promise<void> {
  knownSecrets = new Set(projects.map(p => p.secret));
  // Hydrate every project's persisted ids in parallel. We do NOT clear the
  // in-memory state for projects already populated by a session-mode toggle
  // — those toggles win until the user reloads the page.
  await Promise.all(projects.map(async (p) => {
    if (lastPersisted.has(p.secret)) return; // already hydrated this session
    try {
      const fs = await apiWithSecret<{ hidden_terminals?: string[] | string }>(p.secret, '/file-settings');
      const raw = fs.hidden_terminals;
      let ids: string[] = [];
      if (Array.isArray(raw)) ids = raw.filter((s): s is string => typeof s === 'string');
      else if (typeof raw === 'string' && raw !== '') {
        try { const parsed: unknown = JSON.parse(raw); if (Array.isArray(parsed)) ids = parsed.filter((s): s is string => typeof s === 'string'); } catch { /* ignore */ }
      }
      hydratePersistedHiddenForProject(p.secret, ids);
      // Stash the canonical serialised value so the change subscription
      // doesn't immediately PATCH back the same payload.
      lastPersisted.set(p.secret, JSON.stringify(computePersistedIds(getHiddenTerminals(p.secret))));
    } catch {
      // Network / older server — leave the in-memory state alone.
    }
  }));

  if (subscriptionUnsub === null) {
    subscriptionUnsub = subscribeToHiddenChanges(() => {
      // Only persist toggles for projects we're tracking. Cheaper than
      // hashing every change against a tombstone — diff against last
      // serialised value happens inside writeNow.
      for (const secret of knownSecrets) scheduleWrite(secret);
    });
  }
}

/** Test-only — flush every pending debounced write synchronously. */
export function _flushForTests(): void {
  for (const [secret, timer] of writeTimers) {
    clearTimeout(timer);
    writeTimers.delete(secret);
    void writeNow(secret);
  }
}

/** Test-only — drop every cached state so a fresh init starts clean. */
export function _resetForTests(): void {
  for (const t of writeTimers.values()) clearTimeout(t);
  writeTimers.clear();
  lastPersisted.clear();
  knownSecrets = new Set();
  if (subscriptionUnsub !== null) {
    subscriptionUnsub();
    subscriptionUnsub = null;
  }
}

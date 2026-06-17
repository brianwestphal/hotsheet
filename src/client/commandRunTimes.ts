/**
 * HS-8398 — per-command "last run" timestamps, shown on hover over a custom
 * command button (the button's `title` is computed on `mouseenter` so the
 * relative time stays fresh). Recorded at the click/run site keyed by the same
 * `${secret}::${commandKey(cmd)}` composite the running-state map uses (see
 * `runningKey` in `commandSidebar.tsx`), so it works uniformly for shell AND
 * Claude commands — the command log can't reliably attribute a row back to a
 * specific button (Claude triggers log no button identity, shell matches only
 * by fuzzy text).
 *
 * v1 persistence is per-device `localStorage` (a single JSON map). It survives
 * reloads with zero server cost; cross-device sync is a deliberate follow-up.
 */

const STORAGE_KEY = 'hotsheet:command-last-run';

/** Read the `{ compositeKey: isoTimestamp }` map, tolerating absent / corrupt
 *  storage (returns `{}`). Non-string values are dropped. */
function loadMap(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveMap(map: Record<string, string>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* localStorage disabled / full — last-run is a non-critical hint, drop it. */
  }
}

/**
 * Record that the command identified by `compositeKey` ran. `atIso` defaults to
 * now; it's a parameter so tests can pin the timestamp deterministically.
 */
export function recordCommandRun(compositeKey: string, atIso: string = new Date().toISOString()): void {
  if (compositeKey === '') return;
  const map = loadMap();
  map[compositeKey] = atIso;
  saveMap(map);
}

/** The last-run ISO timestamp for `compositeKey`, or `null` if never recorded. */
export function getCommandLastRun(compositeKey: string): string | null {
  return loadMap()[compositeKey] ?? null;
}

/** TEST ONLY — wipe all recorded run times. */
export function _resetCommandRunTimesForTesting(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

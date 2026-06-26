/**
 * HS-9095 — per-device persistence of command-group collapse state.
 *
 * Group collapse is a **per-machine display preference**, so it must NOT live in
 * the command tree that's persisted to `settings.json`. The pre-fix sidebar
 * mutated `group.collapsed` and wrote the whole effective `custom_commands` tree
 * back to the shared layer (`saveCommandItemsExternal` → `updateSettings`); once
 * `custom_commands` gained an element-level LOCAL delta (HS-9014, docs/108),
 * that wholesale shared write would push local-only commands into the committed
 * file + re-resolve the local delta on top (duplicates). Storing collapse in
 * per-device `localStorage` (this module) removes the shared write entirely — the
 * root-cause fix — and matches how the app already holds per-device UI hints
 * (e.g. `commandRunTimes.ts`).
 *
 * Keyed by `${secret}::${groupId-or-name}` so collapse is per-project. Stable
 * group ids exist after HS-9014's backfill; a group still lacking one falls back
 * to its name (collapse keyed by name is a fine approximation — a name collision
 * just shares collapse state). Reads fall back to a group's legacy `collapsed`
 * field when there's no stored entry, so existing collapse states aren't lost on
 * upgrade.
 */
import type { CommandGroup } from '../settingsCommandDelta.js';

const STORAGE_KEY = 'hotsheet:command-group-collapsed';

/** Stable per-project collapse key for a group. */
export function groupCollapseKey(secret: string, group: CommandGroup): string {
  const id = typeof group.id === 'string' && group.id !== '' ? group.id : group.name;
  return `${secret}::${id}`;
}

/** Read the `{ collapseKey: true }` map, tolerating absent / corrupt storage. */
function loadMap(): Record<string, boolean> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === 'boolean') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function saveMap(map: Record<string, boolean>): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* localStorage disabled / full — collapse is a non-critical view hint, drop it. */
  }
}

/**
 * Whether `group` is collapsed for this device + project. Falls back to the
 * group's legacy `collapsed` field when there's no stored entry (migration), so
 * an existing committed `collapsed: true` still shows collapsed until the user
 * next toggles it (which writes the per-device entry).
 */
export function isGroupCollapsed(secret: string, group: CommandGroup): boolean {
  const map = loadMap();
  const key = groupCollapseKey(secret, group);
  if (key in map) return map[key];
  return group.collapsed === true;
}

/** Persist `group`'s collapse state for this device + project. */
export function setGroupCollapsed(secret: string, group: CommandGroup, collapsed: boolean): void {
  const map = loadMap();
  map[groupCollapseKey(secret, group)] = collapsed;
  saveMap(map);
}

/** TEST ONLY — wipe all stored collapse state. */
export function _resetGroupCollapseForTesting(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

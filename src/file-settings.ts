import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';

const FileSettingsSchema = z.object({
  appName: z.string().optional(),
  appIcon: z.string().optional(),
  backupDir: z.string().optional(),
  ticketPrefix: z.string().optional(),
  secret: z.string().optional(),
  secretPathHash: z.string().optional(),
  port: z.number().optional(),
}).loose();

/** Keys reserved for server/infrastructure use — not project settings. */
const RESERVED_KEYS = new Set(['appName', 'appIcon', 'backupDir', 'ticketPrefix', 'secret', 'secretPathHash', 'port']);

/** Setting keys whose values are JSON (arrays/objects) rather than plain strings.
 *  These are stored as native JSON in settings.json and stringified for the API. */
const JSON_VALUE_KEYS = new Set([
  'categories', 'custom_views', 'custom_commands', 'auto_context', 'terminals',
  // HS-7596 — quit-confirm exempt list (array of process basenames).
  'quit_confirm_exempt_processes',
  // HS-7825 — persisted hidden-terminal ids (configured terminals only;
  // dynamic terminals are session-only). Mirrors the active grouping's
  // hiddenIds post-HS-7826 so older clients reading settings.json still
  // see the user's filter.
  'hidden_terminals',
  // HS-7826 — visibility groupings (named visibility configurations).
  // See docs/39-visibility-groupings.md.
  'visibility_groupings',
  // HS-7952 — per-project permission allow-rules (auto-allow specific
  // tool/pattern pairs without showing the popup). See docs/47-richer-permission-overlay.md.
  'permission_allow_rules',
  // HS-7987 — per-project terminal-prompt allow-rules (auto-respond to a
  // specific parser+question+choice signature without showing the §52
  // overlay). See docs/52-terminal-prompt-overlay.md §52.7.
  'terminal_prompt_allow_rules',
]);

export interface FileSettings {
  appName?: string;
  appIcon?: string;
  backupDir?: string;
  ticketPrefix?: string;
  secret?: string;
  secretPathHash?: string;
  port?: number;
  [key: string]: unknown;
}

function settingsPath(dataDir: string): string {
  return join(dataDir, 'settings.json');
}

export function readFileSettings(dataDir: string): FileSettings {
  const path = settingsPath(dataDir);
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const result = FileSettingsSchema.safeParse(raw);
    if (!result.success) {
      console.warn(`[settings] Invalid settings.json in ${dataDir}: ${result.error.message}`);
      return {};
    }
    return result.data;
  } catch (err: unknown) {
    // HS-8087 — pre-fix this catch was silent: missing file (ENOENT) is
    // the documented "no settings yet" happy path, but real read errors
    // (EACCES on a permission-broken settings dir, EIO on a flaky disk,
    // a JSON.parse exception on a half-written file) ALSO returned `{}`
    // with no signal. Now we still default-empty, but a non-ENOENT
    // failure logs so the user has a fighting chance of noticing
    // permission / disk problems rather than seeing settings silently
    // reset.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[settings] Failed to read settings.json in ${dataDir}: ${err.message}`);
    }
    return {};
  }
}

export function writeFileSettings(dataDir: string, updates: Partial<FileSettings>): FileSettings {
  const current = readFileSettings(dataDir);
  const merged = { ...current, ...updates };
  writeFileSync(settingsPath(dataDir), JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  return merged;
}

/**
 * HS-7829 — pure helper that returns the new `hidden_terminals` value after
 * pruning ids that are no longer present in the supplied configured-terminal
 * id set. Used by the `/file-settings` PATCH handler whenever the user
 * saves a new `terminals[]` array — without this, deleted terminals'
 * hidden-state ids would accumulate forever in `settings.json`.
 *
 * Returns null when no prune is needed (every existing hidden id is still
 * present, or the input is empty / unrecognised). The caller writes back
 * only when a non-null array is returned, so a no-op skips the disk
 * round-trip.
 *
 * Pure: no I/O.
 */
export function prunedHiddenTerminals(
  currentHidden: unknown,
  configuredIds: ReadonlySet<string>,
): string[] | null {
  // Tolerate the legacy stringified-JSON shape for parity with how the
  // /file-settings GET endpoint surfaced JSON-valued keys before HS-7825.
  let raw: unknown = currentHidden;
  if (typeof raw === 'string' && raw !== '') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!Array.isArray(raw)) return null;
  const ids: string[] = raw.filter((s): s is string => typeof s === 'string' && s !== '');
  if (ids.length === 0) return null;
  const pruned = ids.filter(id => configuredIds.has(id));
  if (pruned.length === ids.length) return null; // nothing to prune
  return pruned;
}

/**
 * HS-7826 — pure helper paralleling `prunedHiddenTerminals` but for the
 * new `visibility_groupings` shape. Walks every grouping's `hiddenIds`
 * and drops ids that are no longer in the configured-terminal set.
 * Returns null when no prune is needed; otherwise returns the new
 * groupings array. Tolerates the stringified-JSON shape and skips
 * malformed input as a no-op.
 */
export function prunedVisibilityGroupings(
  currentGroupings: unknown,
  configuredIds: ReadonlySet<string>,
): Array<{ id: string; name: string; hiddenIds: string[] }> | null {
  let raw: unknown = currentGroupings;
  if (typeof raw === 'string' && raw !== '') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!Array.isArray(raw)) return null;
  let changed = false;
  const out: Array<{ id: string; name: string; hiddenIds: string[] }> = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as { id?: unknown; name?: unknown; hiddenIds?: unknown };
    if (typeof obj.id !== 'string' || obj.id === '') continue;
    const name = typeof obj.name === 'string' ? obj.name : '';
    const ids: string[] = Array.isArray(obj.hiddenIds)
      ? obj.hiddenIds.filter((s): s is string => typeof s === 'string' && s !== '')
      : [];
    const kept = ids.filter(id => configuredIds.has(id));
    if (kept.length !== ids.length) changed = true;
    out.push({ id: obj.id, name, hiddenIds: kept });
  }
  return changed ? out : null;
}

/**
 * HS-7949 — when a new terminal id appears in the configured set, it should
 * default to **hidden** in every non-Default grouping (and stay visible in
 * the Default grouping). Without this, a freshly-added terminal pops up in
 * every named grouping the user has built — undoing the curation that's the
 * whole point of having multiple groupings.
 *
 * Pure helper: takes the existing `visibility_groupings` (whatever shape
 * survived parsing — usually the post-prune array from
 * `prunedVisibilityGroupings`) plus the list of newly-added terminal ids,
 * and returns a new groupings array with each new id appended to every
 * non-Default grouping's `hiddenIds`. Returns `null` when no change is
 * required (no new ids OR no non-Default groupings exist OR every new id
 * is already in every non-Default grouping). Tolerates the
 * stringified-JSON shape and skips malformed input as a no-op.
 *
 * The Default grouping id is hard-coded to `'default'` here — same constant
 * the client uses (`DEFAULT_GROUPING_ID` in
 * `src/client/visibilityGroupings.ts`). The server has no other reason to
 * import client code, so duplicating the literal is preferable to a circular
 * dependency.
 */
export function addNewTerminalsToNonDefaultGroupings(
  currentGroupings: unknown,
  newTerminalIds: readonly string[],
): Array<{ id: string; name: string; hiddenIds: string[] }> | null {
  if (newTerminalIds.length === 0) return null;
  let raw: unknown = currentGroupings;
  if (typeof raw === 'string' && raw !== '') {
    try { raw = JSON.parse(raw); } catch { return null; }
  }
  if (!Array.isArray(raw)) return null;
  let changed = false;
  const out: Array<{ id: string; name: string; hiddenIds: string[] }> = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as { id?: unknown; name?: unknown; hiddenIds?: unknown };
    if (typeof obj.id !== 'string' || obj.id === '') continue;
    const name = typeof obj.name === 'string' ? obj.name : '';
    const ids: string[] = Array.isArray(obj.hiddenIds)
      ? obj.hiddenIds.filter((s): s is string => typeof s === 'string' && s !== '')
      : [];
    // The Default grouping is the user's "show everything" baseline — new
    // terminals stay visible there. Every other grouping gets the new id
    // appended to its hidden list.
    if (obj.id === 'default') {
      out.push({ id: obj.id, name, hiddenIds: ids });
      continue;
    }
    const existing = new Set(ids);
    const additions = newTerminalIds.filter(id => !existing.has(id));
    if (additions.length === 0) {
      out.push({ id: obj.id, name, hiddenIds: ids });
      continue;
    }
    changed = true;
    out.push({ id: obj.id, name, hiddenIds: [...ids, ...additions] });
  }
  return changed ? out : null;
}

/** Read project settings from settings.json as Record\<string, string\> for API compatibility.
 *  JSON-valued keys are stringified. Reserved keys (appName, secret, etc.) are excluded. */
export function readProjectSettings(dataDir: string): Record<string, string> {
  const all = readFileSettings(dataDir);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(all)) {
    if (RESERVED_KEYS.has(key)) continue;
    if (value === undefined || value === null) continue;
    // JSON-valued keys: stringify objects/arrays for API compatibility
    if (typeof value === 'object') {
      result[key] = JSON.stringify(value);
    } else if (typeof value === 'string') {
      result[key] = value;
    } else {
      result[key] = JSON.stringify(value);
    }
  }
  return result;
}

/** Write project settings to settings.json at the root level.
 *  Values for JSON keys are parsed from strings to native JSON before storage. */
export function writeProjectSettings(dataDir: string, updates: Record<string, string>): Record<string, string> {
  const fileUpdates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (JSON_VALUE_KEYS.has(key)) {
      // Try to parse as JSON for native storage
      try { fileUpdates[key] = JSON.parse(value); }
      catch { fileUpdates[key] = value; }
    } else {
      fileUpdates[key] = value;
    }
  }
  writeFileSettings(dataDir, fileUpdates);
  return readProjectSettings(dataDir);
}

/** Returns the resolved backup directory path. Defaults to `\{dataDir\}/backups` if not configured. */
export function getBackupDir(dataDir: string): string {
  const settings = readFileSettings(dataDir);
  return typeof settings.backupDir === 'string' && settings.backupDir !== '' ? settings.backupDir : join(dataDir, 'backups');
}

/** Hash the absolute path of settings.json for path-change detection. */
function hashPath(dataDir: string): string {
  const absPath = resolve(settingsPath(dataDir));
  return createHash('sha256').update(absPath).digest('hex').slice(0, 16);
}

/**
 * Ensure a secret exists in settings.json. Regenerate if the data dir path has changed
 * (detected via path hash mismatch). Also writes the current port.
 * Returns the active secret.
 */
export function ensureSecret(dataDir: string, port: number): string {
  const settings = readFileSettings(dataDir);
  const currentPathHash = hashPath(dataDir);

  if (settings.secret !== undefined && settings.secret !== '' && settings.secretPathHash === currentPathHash) {
    // Secret exists and path hasn't changed — just update port
    if (settings.port !== port) {
      writeFileSettings(dataDir, { port });
    }
    return settings.secret;
  }

  // Generate new secret: hash of absolute path + random value
  const random = randomBytes(32).toString('hex');
  const absPath = resolve(settingsPath(dataDir));
  const secret = createHash('sha256').update(absPath + random).digest('hex').slice(0, 32);

  writeFileSettings(dataDir, { secret, secretPathHash: currentPathHash, port });
  return secret;
}

import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';

import { readSecretFile, writeSecretFile } from './secret-file.js';
import { type CommandItem, isCommandTreeDelta, resolveCommandTreeDelta } from './settingsCommandDelta.js';
import { isArrayDelta, resolveDeltaArray } from './settingsDelta.js';

const FileSettingsSchema = z.object({
  appName: z.string().optional(),
  backupDir: z.string().optional(),
  ticketPrefix: z.string().optional(),
  secret: z.string().optional(),
  secretPathHash: z.string().optional(),
  port: z.number().optional(),
  // HS-8934 — git-worktree follower pointer: when set, this `.hotsheet/` owns no
  // DB/project of its own and redirects all project-data resolution to the named
  // authoritative `.hotsheet` folder (docs/89-git-worktrees.md §89.1).
  authoritativeDataDir: z.string().optional(),
}).loose();

/** Keys reserved for server/infrastructure use — not project settings. */
const RESERVED_KEYS = new Set(['appName', 'backupDir', 'ticketPrefix', 'secret', 'secretPathHash', 'port', 'authoritativeDataDir']);

/** Setting keys whose values are JSON (arrays/objects) rather than plain strings.
 *  These are stored as native JSON in settings.json and stringified for the API. */
const JSON_VALUE_KEYS = new Set([
  'categories', 'custom_views', 'custom_commands', 'auto_context', 'terminals',
  // HS-7596 — quit-confirm exempt list (array of process basenames).
  'quit_confirm_exempt_processes',
  // HS-7952 — per-project permission allow-rules (auto-allow specific
  // tool/pattern pairs without showing the popup). See docs/47-richer-permission-overlay.md.
  'permission_allow_rules',
]);

/** Safe string-property read for an unknown list item (no `as`). */
function stringProp(item: unknown, prop: string): string {
  if (typeof item !== 'object' || item === null) return '';
  const v: unknown = Reflect.get(item, prop);
  return typeof v === 'string' ? v : '';
}

/**
 * HS-9010a (docs/95 §95.3) — list keys whose LOCAL layer may hold an element-level
 * delta (`{hidden, added, overrides}`) instead of a whole-array replacement. Each
 * entry's `idOf` identifies a shared item for hide/override targeting.
 * `custom_commands` is a nested group tree and gets its own tree-aware resolver
 * (HS-9010c) — intentionally NOT here.
 */
const DELTA_LIST_KEYS: { key: string; idOf: (item: unknown) => string }[] = [
  { key: 'custom_views', idOf: (i) => stringProp(i, 'id') },
  { key: 'terminals', idOf: (i) => stringProp(i, 'id') },
  { key: 'auto_context', idOf: (i) => `${stringProp(i, 'type')}:${stringProp(i, 'key')}` },
];

/**
 * HS-8290 — keys that USED to be stored per-project but moved to the
 * global config (~/.hotsheet/config.json) under `dashboard.*`. These are
 * stripped on read so an older settings.json still containing them stops
 * surfacing the stale values, and the next write naturally drops them
 * from disk via `writeFileSettings`'s read-merge-write flow.
 *
 * See docs/39-visibility-groupings.md (rewritten for HS-8290) +
 * docs/25-terminal-dashboard.md.
 */
const HS_8290_DEAD_KEYS = new Set([
  'dashboard_layout_mode',
  'dashboard_columns_per_row',
  'dashboard_slider_value',
  'hidden_terminals',
  'visibility_groupings',
  'active_visibility_grouping_id',
]);

/** A settings layer. `shared` = `settings.json` (committed); `local` =
 *  `settings.local.json` (gitignored, this machine only). */
export type SettingsLayer = 'shared' | 'local';

/**
 * HS-9002 — keys whose DEFAULT layer is `local` (`settings.local.json`,
 * gitignored) rather than the committed `settings.json`. These hold
 * machine/user-specific values that shouldn't be checked in: absolute paths,
 * ports, per-device permission grants, personal API-key references, and
 * ephemeral UI/listen state. The split mirrors Claude's `settings.json` /
 * `settings.local.json`: the app reads a merged view (`local` wins) and writes
 * route each key to its layer. The UI can override any key into either layer
 * explicitly (docs/2-data-storage.md §2.12), but these are the starting points.
 */
const LOCAL_SCOPE_KEYS = new Set([
  // Absolute path on this machine (often a cloud-drive path with the user's home + email).
  'backupDir',
  // Preferred server port — can collide across machines.
  'port',
  // Per-device auto-allow rules carrying machine-specific paths/commands.
  'permission_allow_rules',
  'terminal_prompt_allow_rules',
  // References a personal API key by name + ephemeral last-listened timestamp.
  'announcer_ai_key_id',
  'announcer_last_listened_at',
  // Browser/device notification permission state.
  'notify_permission',
  // Per-user, per-screen layout state.
  'detail_position',
  'detail_width',
  'detail_height',
  'detail_visible',
  'drawer_open',
  'drawer_active_tab',
  'drawer_expanded',
  // HS-9005 (docs/95 §95.4, maintainer-classified) — personal preferences /
  // machine-specific settings that shouldn't be committed for the team:
  //   View + sort prefs.
  'hide_verified_column',
  'sort_by',
  'sort_dir',
  'layout',
  //   Notification preference (the permission one is already local above).
  'notify_completed',
  //   Workflow preference.
  'auto_order',
  //   Terminal UX + device appearance/perf.
  'shell_integration_ui',
  'shell_streaming_enabled',
  'terminal_scrollback_bytes',
  'terminal_default',
  //   Quit-confirmation behavior (personal).
  'confirm_quit_with_running_terminals',
  'quit_confirm_exempt_processes',
  //   Protects THIS machine's database.
  'db_snapshot_protection',
  //   Telemetry runs on THIS machine (master + per-signal + retention).
  'telemetry_enabled',
  'telemetry_metrics_enabled',
  'telemetry_logs_enabled',
  'telemetry_traces_enabled',
  'telemetry_retention_days',
  //   Announcer is local-only, never shared (incl. the enable + dismissed-topics;
  //   model/rate/speak-permissions live in machine-Global config already).
  'announcer_enabled',
  'announcer_dismissed_topics',
]);

/** Key suffixes that default to the `local` layer (e.g. `ai_instructions_nudge_dismissed`). */
const LOCAL_SCOPE_SUFFIXES = ['_nudge_dismissed'];

/**
 * HS-9002 — the DEFAULT layer for a setting key. The `secret`/`secretPathHash`
 * sidecar (HS-8999) and the `authoritativeDataDir` worktree pointer are handled
 * outside the shared/local split and stay in their files; everything else falls
 * back to `shared` unless listed above. Programmatic writes via
 * `writeFileSettings` use this to route automatically; the UI may override it.
 */
export function defaultScope(key: string): SettingsLayer {
  if (LOCAL_SCOPE_KEYS.has(key)) return 'local';
  if (LOCAL_SCOPE_SUFFIXES.some(suffix => key.endsWith(suffix))) return 'local';
  return 'shared';
}

export interface FileSettings {
  appName?: string;
  backupDir?: string;
  ticketPrefix?: string;
  secret?: string;
  secretPathHash?: string;
  port?: number;
  /** HS-8934 — git-worktree follower pointer (abs path to an owner `.hotsheet`). */
  authoritativeDataDir?: string;
  [key: string]: unknown;
}

function settingsPath(dataDir: string): string {
  return join(dataDir, 'settings.json');
}

/** Path to the gitignored, machine-local settings file (HS-9002). */
function localSettingsPath(dataDir: string): string {
  return join(dataDir, 'settings.local.json');
}

/**
 * HS-8934 — git-worktree follower resolution (docs/89-git-worktrees.md §89.1).
 *
 * A worktree's `.hotsheet/settings.json` can carry `authoritativeDataDir`
 * pointing at an owner repo's `.hotsheet` folder. When present, this directory
 * is a *follower*: it owns no PGLite DB / project, and all project-data
 * resolution redirects to the owner so the worktree shares the one ticket DB /
 * running instance.
 *
 * Returns the resolved authoritative dir (absolute), or the (absolute) input
 * when there is no pointer. **Throws** on an invalid pointer — a self-reference,
 * a missing target, or a target that is itself a follower (chains not allowed) —
 * so a misconfigured follower errors loudly rather than silently spinning up a
 * second, empty database. One validated hop only.
 */
export function resolveAuthoritativeDataDir(dataDir: string): string {
  const here = resolve(dataDir);
  const pointer = readFileSettings(here).authoritativeDataDir;
  if (typeof pointer !== 'string' || pointer.trim() === '') return here;

  const target = resolve(pointer.trim());
  if (target === here) {
    throw new Error(`[worktree] .hotsheet/settings.json authoritativeDataDir points at itself: ${target}`);
  }
  if (!existsSync(target)) {
    throw new Error(`[worktree] .hotsheet/settings.json authoritativeDataDir target does not exist: ${target}`);
  }
  const targetPointer = readFileSettings(target).authoritativeDataDir;
  if (typeof targetPointer === 'string' && targetPointer.trim() !== '') {
    throw new Error(`[worktree] authoritativeDataDir target is itself a follower (chains not allowed): ${target}`);
  }
  return target;
}

/** Read + validate one settings file (shared or local). Returns `{}` when
 *  absent/unreadable/malformed, stripping HS-8290 dead keys. `label` only
 *  shapes the diagnostic log line. */
function readSettingsFile(path: string, label: string): FileSettings {
  if (!existsSync(path)) return {};
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const result = FileSettingsSchema.safeParse(raw);
    if (!result.success) {
      console.warn(`[settings] Invalid ${label}: ${result.error.message}`);
      return {};
    }
    // HS-8290 — strip dashboard keys that have moved to global config so
    // callers never see stale per-project values. The next write will persist
    // the cleaned shape (read-merge-write on disk).
    const out: FileSettings = {};
    for (const [k, v] of Object.entries(result.data)) {
      if (HS_8290_DEAD_KEYS.has(k)) continue;
      out[k] = v;
    }
    return out;
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
      console.warn(`[settings] Failed to read ${label}: ${err.message}`);
    }
    return {};
  }
}

/** Read ONLY the shared, committed `settings.json` layer (HS-9002). */
export function readSharedSettings(dataDir: string): FileSettings {
  return readSettingsFile(settingsPath(dataDir), `settings.json in ${dataDir}`);
}

/** Read ONLY the gitignored, machine-local `settings.local.json` layer (HS-9002). */
export function readLocalSettings(dataDir: string): FileSettings {
  return readSettingsFile(localSettingsPath(dataDir), `settings.local.json in ${dataDir}`);
}

/**
 * Read the RESOLVED settings — the shared layer overlaid with the local layer,
 * `local` winning (HS-9002). This is the effective view the app runs on, so it's
 * what nearly every consumer wants. To edit a specific file, use
 * `readSharedSettings` / `readLocalSettings` + the layer-specific writers.
 */
export function readFileSettings(dataDir: string): FileSettings {
  const shared = readSharedSettings(dataDir);
  const local = readLocalSettings(dataDir);
  const merged: FileSettings = { ...shared, ...local };
  // HS-9010a (docs/95 §95.3) — for the element-level delta keys, resolve the
  // shared array against the local layer's delta. Gate strictly on the local
  // value being a DELTA object: when it's a plain array / absent the spread
  // above is already correct (local wins, or shared as-is), and — crucially —
  // we must NOT touch the merged value, so a legacy stringified array (HS-6370)
  // or any other shape is preserved for its consumer to parse. This makes the
  // change a true no-op until an editor writes a delta.
  for (const { key, idOf } of DELTA_LIST_KEYS) {
    if (!isArrayDelta(local[key])) continue;
    const sv: unknown = shared[key];
    let sharedArr: unknown[] = [];
    if (Array.isArray(sv)) {
      sharedArr = sv;
    } else if (typeof sv === 'string') {
      try {
        const parsed: unknown = JSON.parse(sv);
        if (Array.isArray(parsed)) sharedArr = parsed;
      } catch { /* leave empty */ }
    }
    merged[key] = resolveDeltaArray(sharedArr, local[key], idOf);
  }
  // HS-9010c/HS-9014 (docs/95 §95.3) — `custom_commands` is a nested group TREE,
  // not a flat list, so it gets its own tree-aware resolver. Same strict gate as
  // the flat keys above: only resolve when the local value is a tree DELTA object
  // (a plain array / absent local is left to the `{...shared, ...local}` spread,
  // preserving legacy whole-replacement + stringified-array shapes — a true
  // no-op until the editor writes a delta).
  if (isCommandTreeDelta(local.custom_commands)) {
    merged.custom_commands = resolveCommandTreeDelta(asCommandTree(shared.custom_commands), local.custom_commands);
  }
  return merged;
}

/** Coerce a shared `custom_commands` value (native array or legacy stringified
 *  array) into a command tree; anything else resolves to an empty tree. */
function asCommandTree(v: unknown): CommandItem[] {
  if (Array.isArray(v)) return v as CommandItem[];
  if (typeof v === 'string') {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) return parsed as CommandItem[];
    } catch { /* not JSON — fall through */ }
  }
  return [];
}

/** Read-merge-write a single layer file. */
function writeSettingsFile(path: string, current: FileSettings, updates: Partial<FileSettings>): FileSettings {
  const merged = { ...current, ...updates };
  writeFileSync(path, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  return merged;
}

/** Write to the shared, committed `settings.json` layer only (HS-9002). */
export function writeSharedSettings(dataDir: string, updates: Partial<FileSettings>): FileSettings {
  return writeSettingsFile(settingsPath(dataDir), readSharedSettings(dataDir), updates);
}

/** Write to the gitignored, machine-local `settings.local.json` layer only (HS-9002). */
export function writeLocalSettings(dataDir: string, updates: Partial<FileSettings>): FileSettings {
  return writeSettingsFile(localSettingsPath(dataDir), readLocalSettings(dataDir), updates);
}

/** Write to an explicitly chosen layer (HS-9002 — the settings UI's three-mode
 *  control writes the layer the user is editing, regardless of the key default). */
export function writeSettingsLayer(dataDir: string, layer: SettingsLayer, updates: Partial<FileSettings>): FileSettings {
  if (layer === 'local') writeLocalSettings(dataDir, updates);
  else writeSharedSettings(dataDir, updates);
  return readFileSettings(dataDir);
}

/**
 * Write settings, routing each key to its default layer (HS-9002): local-scoped
 * keys (`backupDir`, `port`, allow-rules, …) land in `settings.local.json`,
 * everything else in the committed `settings.json`. Existing callers keep
 * working — `backupDir` writes now silently land in the local layer. Returns the
 * resolved (merged) settings.
 */
export function writeFileSettings(dataDir: string, updates: Partial<FileSettings>): FileSettings {
  const sharedUpdates: Partial<FileSettings> = {};
  const localUpdates: Partial<FileSettings> = {};
  for (const [key, value] of Object.entries(updates)) {
    if (defaultScope(key) === 'local') localUpdates[key] = value;
    else sharedUpdates[key] = value;
  }
  if (Object.keys(sharedUpdates).length > 0) writeSharedSettings(dataDir, sharedUpdates);
  if (Object.keys(localUpdates).length > 0) writeLocalSettings(dataDir, localUpdates);
  return readFileSettings(dataDir);
}

/**
 * Remove keys from the local layer ("Reset to shared" in the UI — HS-9002), so
 * the shared value (or default) takes effect again. Direct write because
 * `writeLocalSettings` merges and so can't REMOVE a key. No-op when the local
 * file is absent or holds none of the keys.
 */
export function clearLocalOverrides(dataDir: string, keys: string[]): FileSettings {
  const path = localSettingsPath(dataDir);
  if (existsSync(path)) {
    const current = readLocalSettings(dataDir);
    const toRemove = keys.filter(k => k in current);
    if (toRemove.length > 0) {
      const remaining: FileSettings = {};
      for (const [k, v] of Object.entries(current)) {
        if (!toRemove.includes(k)) remaining[k] = v;
      }
      writeFileSync(path, JSON.stringify(remaining, null, 2) + '\n', 'utf-8');
    }
  }
  return readFileSettings(dataDir);
}

/**
 * HS-9002 — relocate local-scoped keys (`defaultScope === 'local'`) out of a
 * committed `settings.json` into `settings.local.json`, then strip them from the
 * shared file. Mirrors the HS-8999 secret-sidecar migration. Idempotent + safe
 * to run repeatedly: a key already present in the local layer is NOT overwritten
 * (local wins), it's just removed from the shared file. Runs on startup for
 * every registered project so an existing checked-in `settings.json` stops
 * carrying machine-specific values (the `backupDir` leak this ticket fixes).
 */
export function migrateLocalScopedKeys(dataDir: string): void {
  const sharedPath = settingsPath(dataDir);
  if (!existsSync(sharedPath)) return;
  const shared = readSharedSettings(dataDir);
  const localScopedEntries = Object.entries(shared).filter(([k]) => defaultScope(k) === 'local');
  if (localScopedEntries.length === 0) return;

  // Seed the local layer with values not already overridden there (local wins).
  const local = readLocalSettings(dataDir);
  const seed: Partial<FileSettings> = {};
  for (const [k, v] of localScopedEntries) {
    if (!(k in local)) seed[k] = v;
  }
  if (Object.keys(seed).length > 0) writeLocalSettings(dataDir, seed);

  // Strip the relocated keys from settings.json (direct write — a merge can't remove).
  const remaining: FileSettings = {};
  for (const [k, v] of Object.entries(shared)) {
    if (defaultScope(k) === 'local') continue;
    remaining[k] = v;
  }
  writeFileSync(sharedPath, JSON.stringify(remaining, null, 2) + '\n', 'utf-8');
  console.log(`[settings] Relocated ${String(localScopedEntries.length)} machine-local setting(s) to settings.local.json in ${dataDir}`);
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
 * HS-8999 — strip the secret keys from `settings.json` (after migrating them to
 * the `secret.json` sidecar) so the shareable config file carries no secret.
 * `port` is NOT sensitive and stays. Direct write (not `writeFileSettings`,
 * which merges and so can't REMOVE a key).
 */
function stripSecretFromSettings(dataDir: string): void {
  const path = settingsPath(dataDir);
  if (!existsSync(path)) return;
  // HS-9002 — read the SHARED layer only: this writes the result back to
  // settings.json, so a resolved read would drag local-layer keys into the
  // committed file (re-leaking exactly what we relocate).
  const current = readSharedSettings(dataDir);
  if (current.secret === undefined && current.secretPathHash === undefined) return;
  const { secret: _s, secretPathHash: _h, ...rest } = current;
  void _s; void _h;
  writeFileSync(path, JSON.stringify(rest, null, 2) + '\n', 'utf-8');
}

/**
 * Ensure a per-project secret exists, in the `secret.json` sidecar (HS-8999 —
 * previously inline in `settings.json`). Regenerates if the data-dir path has
 * changed (path-hash mismatch). `port` is still written to `settings.json`.
 * Returns the active secret.
 *
 * Migration: on a fresh-from-upgrade project the sidecar is absent — we adopt
 * the existing `settings.json` secret if present (preserving it), else generate
 * a new one (the user confirmed a regenerated secret is fine since this only
 * happens on a version upgrade, when skills + `.mcp.json` re-author anyway). The
 * secret is then written to the sidecar and stripped from `settings.json`.
 */
export function ensureSecret(dataDir: string, port: number): string {
  const sidecar = readSecretFile(dataDir);
  const settings = readFileSettings(dataDir);
  const currentPathHash = hashPath(dataDir);

  if (sidecar.secret !== undefined && sidecar.secret !== '' && sidecar.secretPathHash === currentPathHash) {
    // Sidecar secret valid + path unchanged — just keep `port` current.
    if (settings.port !== port) writeFileSettings(dataDir, { port });
    return sidecar.secret;
  }

  // Adopt the legacy settings.json secret (migration, preserves the value) when
  // it's valid for this path; otherwise mint a fresh one.
  let secret: string;
  if (settings.secret !== undefined && settings.secret !== '' && settings.secretPathHash === currentPathHash) {
    secret = settings.secret;
  } else {
    const random = randomBytes(32).toString('hex');
    secret = createHash('sha256').update(resolve(settingsPath(dataDir)) + random).digest('hex').slice(0, 32);
  }

  writeSecretFile(dataDir, { secret, secretPathHash: currentPathHash });
  writeFileSettings(dataDir, { port });
  stripSecretFromSettings(dataDir);
  return secret;
}

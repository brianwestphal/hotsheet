import { createHash, randomBytes } from 'crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';

import { rememberPreviousDir } from './backupDirChange.js';
import { readSecretFile, writeSecretFile } from './secret-file.js';
import { type CommandItem, isCommandTreeDelta, resolveCommandTreeDelta } from './settingsCommandDelta.js';
import { resolveDeltaArray } from './settingsDelta.js';

/** Exported for the HS-9497 conformance test, which fails if an AI-tool plugin
 *  declares a preference key this schema doesn't have — the guard that lets the
 *  zod fields stay STATIC (and therefore typed) rather than plugin-contributed. */
export const FileSettingsSchema = z.object({
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
  // HS-9091 (docs/106 §106.2) — optional shell command the owner-side integrate
  // helper runs after a `--no-ff` merge ("merge + verify or roll back"). Off by
  // default. §95-classified SHARED (a project build contract) — so it lives in
  // committed `settings.json` and falls through `defaultLayerForKey` to `shared`.
  integrationGate: z.string().optional(),
  // HS-9089 (docs/105 §105.3) — optional per-project worktree-setup command run
  // after node_modules provisioning. §95-classified SHARED (a build contract);
  // the `.hotsheet/worktree-setup.sh` convention is its gitignored-local sibling.
  worktreeSetup: z.string().optional(),
  // HS-9221 (docs/110 §110.4) — opt into inducing AI-authored review notes
  // (Glassbox `.pr-notes/`): when true the worklist injects the `glassbox note
  // instructions` guidance. Default off. §95-classified SHARED (a repo/team
  // property, like committing `.pr-notes/`) — falls through `defaultScope` to
  // `shared`.
  aiReviewNotes: z.boolean().optional(),
  // HS-8009 (docs/113 §113.3) — the project's preferred AI tool. `auto` (default,
  // absent) preserves today's detect-everything behavior. When an explicit CLI
  // agent (`claude`/`codex`/`gemini`/`opencode`/`goose`) is set, terminal command
  // resolution (`{{aiCommand}}`/`{{claudeCommand}}`) launches THAT tool. Editor
  // tools (`cursor`/`copilot`/`windsurf`) are context-only (skills/instructions).
  // A project-level choice → §95 SHARED (not in `LOCAL_SCOPE_KEYS`).
  ai_tool: z.string().optional(),
  // HS-9338 (docs/117 §117.3) — per-project OVERRIDE of the `ai_tool`-derived drive
  // transport (docs/117 §117.2). `auto`/absent = use the capability table; else force
  // `claude-channel` / `mcp-hooks` / `acp` (advanced forms `mcp-hooks:<cmd>` /
  // `acp:<cmd>` also carry a command, honored once HS-9339 lands). §95 **LOCAL** —
  // which transport/binary works is machine-specific (see LOCAL_SCOPE_KEYS).
  agent_backend: z.string().optional(),
  // HS-9327 — when true, the Antigravity play button drops `--dangerously-skip-permissions`
  // and installs a `.agents/hooks.json` PreToolUse hook that routes each tool call
  // through the §47 permission overlay (interactive approve/deny). Default false =
  // the shipped `--print` + auto-approve behavior. Gated so the new hook path can be
  // verified on-device before it becomes the default.
  antigravity_interactive_permissions: z.boolean().optional(),
  // HS-9359 — route codex tool calls through the §47 permission overlay.
  codex_interactive_permissions: z.boolean().optional(),
  // HS-9411 (docs/124) — the "In Development" gates. Declared here so the layered
  // settings API carries them; the authoritative list + labels live in
  // `src/devFeatures.ts`. All are `dev_`-prefixed ⇒ routed to the LOCAL layer by
  // `defaultScope` below, and all default to FALSE (absent = off).
  dev_unreleased_ai_tools: z.boolean().optional(),
  dev_remote_access: z.boolean().optional(),
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

/**
 * HS-9210 — the local-layer delta shape for an element-level override key: a
 * non-array object. Crucially this is TRUE for an empty `{}` (a no-change delta,
 * written when Local mode saves without edits), where `isArrayDelta` /
 * `isCommandTreeDelta` are false. We resolve any delta-shaped local value so the
 * `{...shared, ...local}` spread can't leave the effective list set to a bare
 * `{}` (which read as "every shared item locally hidden"). A legacy
 * whole-replacement array, a scalar, or an absent value is NOT delta-shaped and
 * stays as the spread produced it.
 */
function isDeltaShape(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

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
  // HS-9532 — same reasoning: absolute machine-specific paths, and one device's
  // abandoned backup root is meaningless on another.
  'previousBackupDirs',
  // Preferred server port — can collide across machines.
  'port',
  // Per-device auto-allow rules carrying machine-specific paths/commands.
  'permission_allow_rules',
  'terminal_prompt_allow_rules',
  // HS-9338 (docs/117 §117.3) — the drive-transport override is machine-specific (which
  // agent/binary is installed varies per device), so it's Local, not committed.
  'agent_backend',
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
  //   Announcer is local-only, never shared. HS-9159 — the per-project enable
  //   toggle was removed (always-on); model/rate/speak-permissions live in
  //   machine-Global config already.
  'announcer_dismissed_topics',
  //   HS-9110 (docs/100 §100.2.1(a)) — whether THIS machine may spawn headless
  //   workers (the server reconcile loop's enable). Per-device, never committed.
  'headless_worker_pool',
]);

/** Key suffixes that default to the `local` layer (e.g. `ai_instructions_nudge_dismissed`). */
const LOCAL_SCOPE_SUFFIXES = ['_nudge_dismissed'];

/** HS-9411 (docs/124) — key PREFIXES that default to the `local` layer. `dev_` is
 *  the "In Development" feature gates (`src/devFeatures.ts`): opting a machine into
 *  a half-built surface is a personal, per-device decision and must never be
 *  committed for the team. Enforcing it by prefix (rather than listing each key in
 *  `LOCAL_SCOPE_KEYS`) means a NEW gate cannot accidentally ship as shared. */
const LOCAL_SCOPE_PREFIXES = ['dev_'];

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
  if (LOCAL_SCOPE_PREFIXES.some(prefix => key.startsWith(prefix))) return 'local';
  return 'shared';
}

export interface FileSettings {
  appName?: string;
  backupDir?: string;
  /** HS-9532 — roots `backupDir` previously pointed at, newest first.
   *
   *  Changing `backupDir` abandons the old tree in place: `pruneBackups` and the
   *  attachment GC only ever touch the CURRENT root, so nothing retains, collects
   *  or even mentions the old one (measured: 3.31 GB stranded across 7 projects).
   *  Unless the path is captured at the moment of the write, the information is
   *  gone for good.
   *
   *  Raw strings, deliberately. Deduping properly means `realpath` — symlinks,
   *  `..`, case-insensitive volumes — and this write path is synchronous on
   *  purpose: a `realpath` against an unplugged drive or a dead cloud mount would
   *  stall a settings save, which is the HS-9527 failure mode. Resolution and the
   *  containment classification happen at REPORT time in `backupDirChange.ts`,
   *  where async and "unknown" are both available. */
  previousBackupDirs?: string[];
  ticketPrefix?: string;
  secret?: string;
  secretPathHash?: string;
  port?: number;
  /** HS-8934 — git-worktree follower pointer (abs path to an owner `.hotsheet`). */
  authoritativeDataDir?: string;
  /** HS-9091 — optional owner-side integrate gate command (docs/106 §106.2). */
  integrationGate?: string;
  /** HS-9089 — optional per-project worktree-setup command (docs/105 §105.3). */
  worktreeSetup?: string;
  /** HS-9221 — opt into inducing Glassbox `.pr-notes/` review notes (docs/110). */
  aiReviewNotes?: boolean;
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

/**
 * HS-9600 — short-TTL cache for the settings files, keyed by absolute PATH.
 *
 * `readFileSettings` is called from ~73 sites and on request paths, sometimes
 * more than once per request, and every call used to do `existsSync` +
 * `readFileSync` + `JSON.parse` + a zod `safeParse` — twice, once per layer.
 *
 * Keyed by path rather than `dataDir` on purpose: it covers both layers with one
 * cache, and it is automatically correct for the docs/89 follower case, where
 * `resolveAuthoritativeDataDir` has already redirected to another project's
 * directory before a path is built. A dataDir key could serve one project's
 * settings for another's.
 *
 * The TTL is what covers OUT-of-process edits — the user editing `settings.json`
 * by hand, a `git pull`, a second Hot Sheet instance. In-process writes do not
 * wait for it: every write in this module goes through `writeSettingsFileAtPath`,
 * which invalidates synchronously. That funnel is the design — a cache that only
 * hooked `writeFileSettings` would go stale on the docs/95 scope-layer moves,
 * which write their files directly.
 *
 * Beyond the CPU, this is the CLAUDE.md §"filesystem access on a user-configured
 * path" concern: `dataDir` is user-chosen, so on an iCloud/Drive-backed project
 * these are content reads on a request path — the HS-9527 class, with small
 * files but a far higher call rate.
 */
const SETTINGS_CACHE_TTL_MS = 5_000;

interface SettingsCacheEntry {
  value: FileSettings;
  readAt: number;
  /** The file stamp the cached value was parsed from. `null` = the file did not
   *  exist, which is a cacheable fact too (a brand-new project reads `{}`). */
  stamp: string | null;
}

const settingsCache = new Map<string, SettingsCacheEntry>();

/** Clock seam. An injected `now` beats fake timers here — the read path is
 *  synchronous and the rest of this codebase already prefers injected clocks. */
let settingsCacheNow: () => number = Date.now;

/**
 * Identity of the file's current contents, cheaply. `mtimeMs` + `size` is the
 * standard pairing: size alone misses same-length edits, mtime alone can collide
 * within one filesystem tick.
 *
 * `statSync` is a METADATA call, and CLAUDE.md §"Filesystem access on a
 * user-configured path" is explicit that the hazard is a sync call that must
 * fetch or flush BYTES — metadata is cached locally even by a File Provider
 * (measured: 0.6 ms for readdir + per-entry existsSync against Google Drive).
 * This also REPLACES the `existsSync` the read path already did, so the syscall
 * count per read does not go up; what goes away is the `readFileSync` +
 * `JSON.parse` + zod `safeParse` on every call.
 */
function fileStamp(path: string): string | null {
  try {
    const st = statSync(path);
    return `${String(st.mtimeMs)}:${String(st.size)}`;
  } catch {
    return null;
  }
}

/** Drop one path's entry. Called by every writer in this module. */
function invalidateSettingsPath(path: string): void {
  settingsCache.delete(path);
}

/**
 * Drop everything. Exported for a caller that changes settings files out of band
 * and cannot wait for the next stat (tests, mainly); ordinary writes do not need
 * it, and neither do external edits — those are caught by the stamp.
 */
export function invalidateSettingsCache(): void {
  settingsCache.clear();
}

/** How many times a settings file has actually been read+parsed. The cache's
 *  whole job is to keep this flat while nothing changes, and there is no other
 *  way to observe that from outside. */
let settingsParseCount = 0;

/** Test seam: clear the cache and optionally drive the clock. */
export function _resetSettingsCacheForTests(now?: () => number): void {
  settingsCache.clear();
  settingsCacheNow = now ?? Date.now;
  settingsParseCount = 0;
}

/** Test seam — see `settingsParseCount`. */
export function _settingsParseCountForTests(): number {
  return settingsParseCount;
}

/**
 * Read + validate one settings file (shared or local). Returns `{}` when
 * absent/unreadable/malformed, stripping HS-8290 dead keys. `label` only shapes
 * the diagnostic log line.
 *
 * HS-9600 — cached, and validated two ways:
 *
 * 1. **The file stamp** (mtime+size) — so an out-of-process edit (the user
 *    editing `settings.json` by hand, a `git pull`, a second instance) is picked
 *    up on the very next read. A blind TTL would have made those invisible for
 *    seconds, and 20 test files plus any future caller legitimately expect an
 *    external write to be seen immediately. Correctness first; the saving is the
 *    read+parse+validate, which is the expensive part regardless.
 * 2. **A 5 s TTL** on top, as a ceiling — cheap insurance against a filesystem
 *    with coarse mtime granularity or a clock that moves oddly.
 *
 * The result is **cloned on the way out**, on both hit and miss, so callers keep
 * the mutation-safety they had when every call re-parsed from disk:
 * `readFileSettings` merges these shallowly, so handing out the cached object
 * would let an in-place edit of a nested value (`terminals`, `custom_commands`)
 * corrupt every other reader.
 */
function readSettingsFile(path: string, label: string): FileSettings {
  const stamp = fileStamp(path);
  const cached = settingsCache.get(path);
  const fresh = cached !== undefined
    && cached.stamp === stamp
    && settingsCacheNow() - cached.readAt < SETTINGS_CACHE_TTL_MS;
  if (fresh) return structuredClone(cached.value);

  // `null` stamp = no file. Skip the read entirely and cache the empty result,
  // so a brand-new project doesn't re-probe on every call either.
  const value = stamp === null ? {} : readSettingsFileUncached(path, label);
  settingsCache.set(path, { value, readAt: settingsCacheNow(), stamp });
  return structuredClone(value);
}

function readSettingsFileUncached(path: string, label: string): FileSettings {
  settingsParseCount += 1;
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
  // shared array against the local layer's delta. Gate on the local value being
  // a delta-shaped object (a non-array object — see `isDeltaShape`): when it's a
  // plain array / absent the spread above is already correct (local wins, or
  // shared as-is), and — crucially — we must NOT touch the merged value, so a
  // legacy stringified array (HS-6370) or any other shape is preserved for its
  // consumer to parse. This is a true no-op for non-delta values.
  for (const { key, idOf } of DELTA_LIST_KEYS) {
    // HS-9210 — resolve whenever the local value is a non-array object (the delta
    // shape), NOT only when it's a *populated* delta. An EMPTY delta `{}` (written
    // when Local mode saves with no changes) isn't an `isArrayDelta`, but the
    // `{...shared, ...local}` spread above already clobbered `merged[key]` with that
    // empty object — so without resolving here the effective list became `{}` and
    // every shared item read as "locally hidden". `resolveDeltaArray` falls back to
    // the shared array for an empty / non-delta object, so this is the correct no-op.
    // Arrays (legacy whole-replacement) / scalars / absent are left to the spread.
    if (!isDeltaShape(local[key])) continue;
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
  // not a flat list, so it gets its own tree-aware resolver. Resolve whenever the
  // local value is a non-array object (the delta shape), incl. an EMPTY `{}`
  // (HS-9210) — same clobber-via-spread reasoning as the flat keys above.
  // `resolveCommandTreeDelta` of an empty / non-delta object falls back to the
  // shared tree. Arrays (legacy whole-replacement) / scalars / absent are left to
  // the spread, preserving legacy whole-replacement + stringified-array shapes.
  if (isDeltaShape(local.custom_commands)) {
    // A non-delta / empty object resolves to the shared tree (`{}` is a valid,
    // all-optional CommandTreeDelta).
    const delta = isCommandTreeDelta(local.custom_commands) ? local.custom_commands : {};
    merged.custom_commands = resolveCommandTreeDelta(asCommandTree(shared.custom_commands), delta);
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

/**
 * HS-9600 — the ONE place this module writes a settings file. Every writer goes
 * through it so the cache cannot be left stale by a path that forgot to
 * invalidate; that is the failure mode ("I changed a setting and it didn't
 * take"), and making it structurally impossible beats remembering.
 */
function writeSettingsFileAtPath(path: string, data: unknown): void {
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  invalidateSettingsPath(path);
}

/** Read-merge-write a single layer file. */
function writeSettingsFile(path: string, current: FileSettings, updates: Partial<FileSettings>): FileSettings {
  const merged = { ...current, ...updates };
  writeSettingsFileAtPath(path, merged);
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
/**
 * HS-9532 — if this update changes `backupDir`, fold the outgoing value into
 * `previousBackupDirs`.
 *
 * Returns the updates unchanged when `backupDir` isn't moving, so the common
 * settings write is untouched. Dedup here is by RAW string (see the field's
 * doc comment); two spellings of one directory are collapsed later, where
 * `realpath` is affordable.
 */
function withPreviousBackupDir(dataDir: string, updates: Partial<FileSettings>): Partial<FileSettings> {
  const next = updates.backupDir;
  if (typeof next !== 'string') return updates;
  const current = readFileSettings(dataDir);
  const prev = current.backupDir;
  if (typeof prev !== 'string' || prev.trim() === '' || prev === next) return updates;
  return {
    ...updates,
    previousBackupDirs: rememberPreviousDir(current.previousBackupDirs ?? [], prev, next),
  };
}

export function writeFileSettings(dataDir: string, updates: Partial<FileSettings>): FileSettings {
  // HS-9532 — capture the outgoing `backupDir` BEFORE it is overwritten. Once the
  // write lands, the old root is unreachable from any state the app keeps, and
  // the tree it points at silently stops being retained, collected, or mentioned.
  //
  // Raw string, no filesystem access: this function is synchronous, and a
  // `realpath` against a dead cloud mount here would stall the settings save
  // (HS-9527). Resolution + containment classification are done at report time.
  const effectiveUpdates = withPreviousBackupDir(dataDir, updates);
  const sharedUpdates: Partial<FileSettings> = {};
  const localUpdates: Partial<FileSettings> = {};
  for (const [key, value] of Object.entries(effectiveUpdates)) {
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
      writeSettingsFileAtPath(path, remaining);
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
  writeSettingsFileAtPath(sharedPath, remaining);
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
  writeSettingsFileAtPath(path, rest);
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

import { clearLocalSettingOverride, disableChannel, enableChannel, getChannelStatus, getClaudeVersionCheck, getGlobalConfig, getLayeredFileSettings, getSettings, updateFileSettingsLayer } from '../api/index.js';
// HS-9014 — the canonical command-tree types + `isGroup` live in the server-safe
// `settingsCommandDelta` module (shared with the file-settings resolver). Re-export
// them here so the many `from './experimentalSettings.js'` importers keep working.
import {
  backfillCommandIds,
  type CommandGroup,
  type CommandItem,
  type CommandTreeDelta,
  computeCommandTreeDelta,
  type CustomCommand,
  isCommandTreeDelta,
  isGroup,
  moveChildToLocal,
  moveChildToShared,
  moveTopLevelToLocal,
  moveTopLevelToShared,
  resolveCommandTreeDelta,
  stripCommandTreeIds,
} from '../settingsCommandDelta.js';
import { initChannel } from './channelUI.js';
import { renderCustomCommandSettings } from './commandEditor.js';
import { renderChannelCommands } from './commandSidebar.js';
import { byId, byIdOrNull } from './dom.js';
// All Lucide icons loaded from generated JSON
import ALL_LUCIDE_ICONS from './lucide-icons.json';
import { copyJsonToClipboard, newEntriesById, parsePastedEntries, readClipboardJsonOrPrompt } from './settingsClipboard.js';
import { getScopeMode } from './settingsScope.js';
import type { ScopeMode } from './settingsSharing.js';
import { showToast } from './toast.js';

export const CMD_ICONS: { name: string; svg: string }[] = Object.entries(ALL_LUCIDE_ICONS as Record<string, string>).map(([name, svg]) => ({ name, svg }));

export type { CommandGroup, CommandItem, CustomCommand };
export { isGroup };

// Predefined color palette for command buttons
export const CMD_COLORS = [
  { value: '#e5e7eb', label: 'Neutral' },
  { value: '#3b82f6', label: 'Blue' },
  { value: '#22c55e', label: 'Green' },
  { value: '#f97316', label: 'Orange' },
  { value: '#ef4444', label: 'Red' },
  { value: '#8b5cf6', label: 'Purple' },
  { value: '#ec4899', label: 'Pink' },
  { value: '#14b8a6', label: 'Teal' },
  { value: '#6b7280', label: 'Gray' },
];

let commandItems: CommandItem[] = [];

// HS-9014 (docs/95 §95.3) — scope-aware editing state. `commandItems` is the
// tree the editor currently shows + edits: in Resolved mode the effective tree
// (also what the sidebar renders), in Shared mode the committed `settings.json`
// array, in Local mode the effective tree resolved from shared + the local
// delta. `commandShared` is the pristine shared tree, kept so a Local-mode save
// can derive the delta (`computeCommandTreeDelta`) against it.
let commandMode: ScopeMode = 'local'; // HS-9166 — default mode (was the removed 'resolved')
let commandShared: CommandItem[] = [];

// HS-9014 — `commandItems` is the SIDEBAR's tree (always the resolved/effective
// commands, set by `reloadCustomCommands`). `editTree` is what the Settings
// EDITOR shows + mutates: in Resolved mode it's the SAME array object as
// `commandItems` (so an edit updates the sidebar directly, exactly as before);
// in Shared/Local mode it's a separate, mode-specific tree, and the sidebar is
// refreshed from the server's resolved view after each save. The ItemRef
// helpers + the editor's render/DnD operate on `editTree`; the sidebar's
// `renderChannelCommands` reads `commandItems`.
let editTree: CommandItem[] = [];

// HS-9184 — ids of shared commands the local layer OVERRIDES (the delta's
// `overrides` keys, in Local mode). Drives the per-row "reset to shared"
// (undo-2) affordance. Empty in Shared mode (nothing to reset there).
let commandOverriddenIds = new Set<string>();

/** The editor's working tree (mode-specific). */
export function getEditTree(): CommandItem[] {
  return editTree;
}

/** HS-9184 — ids of shared commands locally overridden (Local mode only). */
export function getCommandOverriddenIds(): Set<string> {
  return commandOverriddenIds;
}

/** Test-only — seed the overridden-id set (production fills it from the local
 *  delta in `loadScopedCommands`, which needs the layered-settings transport). */
export function _setCommandOverriddenIdsForTests(ids: Set<string>): void {
  commandOverriddenIds = ids;
}

/** HS-9183 — the shared commands HIDDEN on this machine (Local mode), each as a
 *  flat `{ id, name }` for the dimmed "hidden" rows. Computed LIVE: a shared item
 *  (top-level command/group or group child) that's absent from the editor's
 *  resolved tree (`editTree`) is hidden — so a just-hidden command surfaces
 *  immediately, before the next reload. A hidden group covers its children.
 *  Empty outside Local mode (hide-on-this-machine doesn't apply). */
export function getHiddenSharedCommands(): { id: string; name: string }[] {
  if (commandMode !== 'local') return [];
  // Every shared id currently PRESENT in the resolved editor tree.
  const present = new Set<string>();
  for (const item of editTree) {
    if (typeof item.id === 'string' && item.id !== '') present.add(item.id);
    if (isGroup(item)) {
      for (const ch of item.children) {
        if (typeof ch.id === 'string' && ch.id !== '') present.add(ch.id);
      }
    }
  }
  const out: { id: string; name: string }[] = [];
  for (const item of commandShared) {
    const id = typeof item.id === 'string' ? item.id : '';
    if (id !== '' && !present.has(id)) {
      out.push({ id, name: item.name !== '' ? item.name : '(untitled)' });
      continue; // a hidden group covers its children — don't list them twice
    }
    if (isGroup(item) && present.has(id)) {
      for (const ch of item.children) {
        const cid = typeof ch.id === 'string' ? ch.id : '';
        if (cid !== '' && !present.has(cid)) {
          out.push({ id: cid, name: `${item.name} › ${ch.name !== '' ? ch.name : '(untitled)'}` });
        }
      }
    }
  }
  return out;
}

/** Test-only — seed the pristine shared tree (production fills it from the shared
 *  layer in `loadScopedCommands`). Needed to resolve hidden ids → names. */
export function _setCommandSharedForTests(items: CommandItem[]): void {
  commandShared = items;
}

/** The scope mode the command editor last loaded for. */
export function getCommandMode(): ScopeMode {
  return commandMode;
}

/** Test-only — force the editor scope mode. Production derives it from
 *  `getScopeMode()` on dialog open / scope switch (`loadScopedCommands`); tests
 *  that don't go through that path (no layered-settings transport) set it
 *  directly, e.g. to render the editable Shared view (HS-9127 made Resolved
 *  read-only). */
export function _setCommandModeForTests(mode: ScopeMode): void {
  commandMode = mode;
}

/** The pristine shared command tree (for the editor's origin tags). */
export function getCommandShared(): CommandItem[] {
  return commandShared;
}

// HS-8440 — mutation epoch for the in-memory `commandItems` list.
// `reloadCustomCommands()` is fire-and-forget from two paths in this file
// (line ~199 on settings-btn click; line ~249 at bind time) plus the
// project-switch path. Pre-fix, any in-flight reload whose `await
// getSettings()` had not yet resolved would, on resolution, blindly
// reassign `commandItems` to the fetched snapshot — even if the user (or
// in CI, the test) had just performed a local edit (delete / add / name-
// change). The local edit was silently overwritten and the row reappeared.
// Surfaced as a CI e2e flake on v0.17.0-beta.18 (`commands.spec.ts › delete
// an empty group`); the production exposure is small but real on slow disks
// where /api/settings takes >100ms to respond and the user clicks delete
// within that window. Guard: every local mutation calls
// `noteCommandItemsMutation()` before its `saveCommandItems()` PATCH;
// `reloadCustomCommands()` captures the epoch BEFORE awaiting and abandons
// its response (no reassignment, no render) if the epoch has advanced. The
// saveCommandItems PATCH is the authoritative write — stale reloads
// shouldn't re-introduce pre-edit state.
let commandItemsMutationEpoch = 0;
export function noteCommandItemsMutation(): void {
  commandItemsMutationEpoch++;
}

let channelEnabledState = false;

/** Reference to a command item: either top-level or a child within a group. */
export type ItemRef =
  | { type: 'top'; index: number }
  | { type: 'child'; groupIndex: number; childIndex: number };

/** Resolve an ItemRef to the actual CustomCommand (against the editor tree). */
export function resolveCommand(ref: ItemRef): CustomCommand {
  if (ref.type === 'top') return editTree[ref.index] as CustomCommand;
  return (editTree[ref.groupIndex] as CommandGroup).children[ref.childIndex];
}

/** Update a CustomCommand in-place at the given ref. */
export function updateCommand(ref: ItemRef, updater: (cmd: CustomCommand) => void) {
  updater(resolveCommand(ref));
}

/** Delete a command or group at the given ref (in the editor tree). */
export function deleteAtRef(ref: ItemRef) {
  if (ref.type === 'top') {
    editTree.splice(ref.index, 1);
  } else {
    const group = editTree[ref.groupIndex] as CommandGroup;
    group.children.splice(ref.childIndex, 1);
  }
}

/** Migrate old-format commands (with group field) to new CommandItem[] format. */
function migrateOldFormat(data: unknown[]): CommandItem[] {
  // Check if any item has a `group` field (old format)
  interface OldCommand {
    name: string;
    prompt: string;
    icon?: string;
    color?: string;
    target?: 'claude' | 'shell';
    autoShowLog?: boolean;
    group?: string;
  }
  const hasOldFormat = data.some((item) => typeof item === 'object' && item !== null && 'group' in item && typeof (item as OldCommand).group === 'string' && (item as OldCommand).group!.trim() !== '');

  if (!hasOldFormat) {
    // Already new format or no groups — but ensure groups have children arrays
    return (data as CommandItem[]).map(item => {
      if (isGroup(item) && !Array.isArray(item.children)) {
        return { ...item, children: [] };
      }
      return item;
    });
  }

  // Collect ungrouped commands and group commands
  const ungrouped: CustomCommand[] = [];
  const groupOrder: string[] = [];
  const groups = new Map<string, CustomCommand[]>();

  for (const rawItem of data) {
    const item = rawItem as OldCommand;
    const g = item.group?.trim() ?? '';
    // Strip the group field from the command
    const cmd: CustomCommand = { name: item.name, prompt: item.prompt };
    if (item.icon !== undefined && item.icon !== '') cmd.icon = item.icon;
    if (item.color !== undefined && item.color !== '') cmd.color = item.color;
    if (item.target !== undefined) cmd.target = item.target;
    if (item.autoShowLog === true) cmd.autoShowLog = item.autoShowLog;

    if (g === '') {
      ungrouped.push(cmd);
    } else {
      if (!groups.has(g)) {
        groupOrder.push(g);
        groups.set(g, []);
      }
      groups.get(g)!.push(cmd);
    }
  }

  // Build new list: ungrouped first, then each group with its children
  const result: CommandItem[] = [...ungrouped];
  for (const groupName of groupOrder) {
    result.push({ type: 'group', name: groupName, children: groups.get(groupName)! });
  }

  return result;
}

/** Reload custom commands from the active project's settings. Called on project switch.
 *
 * HS-8440 — guards against stale-reload-overwrites-local-edit. Captures the
 * mutation epoch BEFORE the `await`; if a local mutation
 * (`noteCommandItemsMutation()`) ran while the fetch was in flight, the
 * resolved snapshot is discarded — `commandItems` keeps its post-edit
 * state, and the caller's `.then(renderCustomCommandSettings)` chain still
 * runs but renders from the unchanged (post-edit) `commandItems`. The
 * skipped reload is intentionally silent (no toast, no log) — the next
 * mutation's `saveCommandItems()` PATCH is the authoritative write and
 * any subsequent reload will pick up the correct state.
 */
export async function reloadCustomCommands(): Promise<void> {
  const epochBeforeFetch = commandItemsMutationEpoch;
  try {
    const settings = await getSettings();
    if (commandItemsMutationEpoch !== epochBeforeFetch) return;
    if (settings.custom_commands !== '') {
      try {
        // HS-8567 — defer per-item validation to `migrateOldFormat`; just
        // narrow the outer shape to "array of unknown" here.
        const raw: unknown = JSON.parse(settings.custom_commands);
        commandItems = Array.isArray(raw) ? migrateOldFormat(raw) : [];
      } catch { commandItems = []; }
    } else {
      commandItems = [];
    }
  } catch {
    if (commandItemsMutationEpoch !== epochBeforeFetch) return;
    commandItems = [];
  }
  // HS-9014 — `getSettings()` returns the effective tree (what the sidebar
  // renders). The scope-aware editor loader (`loadScopedCommands`) re-derives the
  // mode-specific tree on the next settings-dialog open / scope switch; until then
  // alias the editor tree to the sidebar's effective tree as a transient default.
  commandMode = 'local'; // HS-9166 — was the removed 'resolved'
  editTree = commandItems;
}

/** Coerce a layered `custom_commands` value (native array or legacy stringified
 *  array) into a command tree; anything else → empty tree. */
function asCommandArray(v: unknown): CommandItem[] {
  if (Array.isArray(v)) return migrateOldFormat(v);
  if (typeof v === 'string' && v !== '') {
    try {
      const parsed: unknown = JSON.parse(v);
      if (Array.isArray(parsed)) return migrateOldFormat(parsed);
    } catch { /* not JSON */ }
  }
  return [];
}

/**
 * HS-9014 (docs/95 §95.3) — load `custom_commands` for the active scope mode,
 * making the editor tree mode-specific:
 *  - **Shared** → the committed `settings.json` array.
 *  - **Local** → the effective tree (shared resolved against the local delta);
 *    edits are persisted back as a tree delta vs `commandShared`.
 *
 * Backfills stable ids into the shared tree and PERSISTS them to `settings.json`
 * so the local delta can target stable ids across renames/reorders (the
 * structural id migration is idempotent + safe to run in any mode).
 */
export async function loadScopedCommands(): Promise<void> {
  const epochBeforeFetch = commandItemsMutationEpoch;
  try {
    const layered = await getLayeredFileSettings();
    if (commandItemsMutationEpoch !== epochBeforeFetch) return;
    commandMode = getScopeMode();

    // Backfill ids on the shared tree + persist if anything was missing.
    const sharedBackfill = backfillCommandIds(asCommandArray(layered.shared.custom_commands));
    if (sharedBackfill.changed) {
      noteCommandItemsMutation();
      await updateFileSettingsLayer('shared', { custom_commands: sharedBackfill.items });
    }
    commandShared = sharedBackfill.items;

    const localVal = layered.local.custom_commands;
    // HS-9184 — track which shared commands the local layer overrides (Local mode
    // only) so each overridden row can offer a "reset to shared" affordance.
    commandOverriddenIds = commandMode === 'local' && isCommandTreeDelta(localVal)
      ? new Set(Object.keys(localVal.overrides ?? {}))
      : new Set<string>();
    let display: CommandItem[];
    if (commandMode === 'shared') {
      display = commandShared;
    } else if (isCommandTreeDelta(localVal)) {
      display = resolveCommandTreeDelta(commandShared, localVal);
    } else if (Array.isArray(localVal)) {
      display = asCommandArray(localVal); // legacy whole-replacement local override
    } else {
      display = commandShared; // no local override → effective == shared
    }
    // Backfill any local-only items lacking ids (so delete/override can target them).
    editTree = backfillCommandIds(display).items;
  } catch {
    if (commandItemsMutationEpoch !== epochBeforeFetch) return;
    editTree = [];
    commandShared = [];
  }
}

/**
 * HS-9014 — after a Shared/Local-mode save, the sidebar must reflect the new
 * EFFECTIVE (resolved) command tree without disturbing the editor's
 * mode-specific `editTree`. Re-fetches the resolved tree into `commandItems`
 * (the sidebar source) and re-renders the sidebar.
 */
async function refreshSidebarFromResolved(): Promise<void> {
  try {
    const settings = await getSettings();
    commandItems = settings.custom_commands !== '' ? asCommandArray(settings.custom_commands) : [];
  } catch {
    return;
  }
  renderChannelCommands();
}

/**
 * HS-9014 — after the settings dialog closes following Shared/Local edits, the
 * sidebar (which renders from `commandItems`) must return to the RESOLVED
 * effective tree. Reloads it + re-renders the sidebar.
 */
export async function refreshCommandsAfterDialogClose(): Promise<void> {
  await reloadCustomCommands();
  renderChannelCommands();
}

/** HS-9014 — reload the editor tree for the new layer when the dialog scope mode
 *  changes. Bound once (idempotent), mirroring the terminals/auto_context editors. */
let commandScopeListenerBound = false;
function ensureCommandScopeListener(): void {
  if (commandScopeListenerBound) return;
  commandScopeListenerBound = true;
  document.addEventListener('hotsheet:scope-mode-changed', () => {
    void loadScopedCommands().then(() => { renderCustomCommandSettings(); });
  });
}

export function isChannelEnabled(): boolean {
  return channelEnabledState;
}

export function setChannelEnabledState(enabled: boolean) {
  channelEnabledState = enabled;
}

export function contrastColor(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  // Relative luminance
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#1a1a1a' : '#ffffff';
}

export { renderChannelCommands };
export { getCommandItems };

function getCommandItems(): CommandItem[] {
  return commandItems;
}

export async function saveCommandItems() {
  // HS-8440 — bump BEFORE the await so any in-flight `reloadCustomCommands`
  // whose fetch is currently suspended sees a stale epoch on resume and
  // abandons its response. Centralized here (the chokepoint for every
  // local-mutation save) so individual callsites don't have to remember.
  noteCommandItemsMutation();
  // HS-9014 (docs/95 §95.3) — route the save per scope mode:
  //  - Shared → write the edited tree to `settings.json`; it becomes the new
  //    pristine shared baseline.
  //  - Local → write the element-level delta (vs the shared baseline) to
  //    `settings.local.json` (removing a shared item hides it; an added item is
  //    local-only; a local child in a shared group → childAdded).
  //  - Resolved → today's default-routed save (writes to the shared layer),
  //    exactly preserving pre-HS-9014 behavior.
  if (commandMode === 'shared') {
    await updateFileSettingsLayer('shared', { custom_commands: editTree });
    commandShared = backfillCommandIds(editTree).items.map(cloneItem);
    commandOverriddenIds = new Set<string>(); // HS-9220 — nothing is "overridden" in Shared mode
    await refreshSidebarFromResolved();
  } else {
    // HS-9264 — backfill ids on the editor tree BEFORE deriving the delta so a
    // freshly-added local command (pushed WITHOUT an id by the "Add Command" /
    // "Add Group" handlers) is stored in `delta.added` with the SAME stable id
    // the editor will show. Without this, `loadScopedCommands` later backfills a
    // DIFFERENT random id into the resolved tree while the delta's added item
    // stays id-less, so `moveTopLevelToShared` (which matches by id) can't find
    // the most-recently-added — i.e. bottom-most — command and its Move-to-Shared
    // silently no-ops. Earlier additions escaped this because a subsequent save
    // re-derived the delta from an already-backfilled tree. In Local mode
    // `editTree` is its own array (not aliased to the sidebar's `commandItems`),
    // so reassigning is safe; the freshly-derived delta persists the same ids.
    editTree = backfillCommandIds(editTree).items;
    const delta = computeCommandTreeDelta(commandShared, editTree);
    // HS-9220 — recompute the overridden-id set from the just-derived delta
    // SYNCHRONOUSLY (before any await), so a local edit's "overridden" tag +
    // reset-to-shared (undo-2) affordance surface as soon as the editor next
    // renders (e.g. when the edit modal closes). Pre-fix this set was refreshed
    // only by `loadScopedCommands` (scope switch / dialog reopen), so the row
    // kept its stale "shared" tag with no reset button until the user toggled
    // views and back.
    commandOverriddenIds = new Set(Object.keys(delta.overrides ?? {}));
    await persistLocalCommandDelta(delta);
    await refreshSidebarFromResolved();
  }
}

/** HS-8857 — copy the current custom-command tree to the clipboard as JSON, to
 *  paste into another project. */
export function copyCustomCommands(): void {
  void copyJsonToClipboard(editTree, 'Custom commands');
}

/**
 * HS-8857 — paste a custom-command tree from the clipboard and MERGE it into the
 * current editor: add top-level items whose name isn't already present (dedup by
 * group/command name so re-pasting doesn't duplicate), keeping existing untouched.
 * Pasted ids are stripped + re-backfilled so a tree from another project can't
 * collide with this project's ids. Writes to whichever scope layer is shown.
 */
export async function pasteCustomCommands(): Promise<void> {
  const raw = await readClipboardJsonOrPrompt('Paste custom commands');
  if (raw === null) return;
  const incoming = parsePastedEntries(raw, 'custom commands',
    v => Array.isArray(v) ? asCommandArray(v) : null);
  if (incoming === null) return;
  // Dedup by name (group vs command kept distinct); then re-id the additions.
  const nameKey = (i: CommandItem): string => (isGroup(i) ? `g:${i.name}` : `c:${i.name}`);
  const toAdd = newEntriesById(editTree, incoming, nameKey);
  if (toAdd.length === 0) {
    showToast('No new custom commands to add', { variant: 'info' });
    return;
  }
  editTree.push(...backfillCommandIds(stripCommandTreeIds(toAdd)).items);
  await saveCommandItems();
  renderCustomCommandSettings();
  showToast(`Added ${String(toAdd.length)} custom command${toAdd.length === 1 ? '' : 's'}`, { variant: 'success' });
}

/** Deep-ish clone of a command item (a fresh object + fresh children array) so
 *  the pristine shared baseline doesn't alias the editable tree. */
function cloneItem(item: CommandItem): CommandItem {
  return isGroup(item) ? { ...item, children: item.children.map(c => ({ ...c })) } : { ...item };
}

/** HS-9014 — persist the local `custom_commands` delta, CLEARING the local
 *  override entirely when the delta is empty. Writing a literal `{}` would make
 *  `readFileSettings` resolve `custom_commands` to `{}` (no longer a delta), and
 *  the consumer would read zero commands — clearing keeps the shared tree. */
async function persistLocalCommandDelta(delta: CommandTreeDelta): Promise<void> {
  if (Object.keys(delta).length === 0) {
    await clearLocalSettingOverride(['custom_commands']);
  } else {
    await updateFileSettingsLayer('local', { custom_commands: delta });
  }
}

/**
 * HS-9014 (maintainer request) + HS-9094 — move a command/group between the
 * shared + local layers in one action, editing both layer files. `to-local`
 * makes a shared item local-only (drops from `settings.json`, adds as a local
 * addition); `to-shared` promotes a local-only item into the committed tree.
 * `level` is `top` for a top-level command/group or `child` for a command inside
 * a group (a shared child relocates into/out of its group's `childAdded`).
 * Reloads the editor for the active mode + refreshes the sidebar afterward.
 */
export async function moveCommandLayer(id: string, direction: 'to-local' | 'to-shared', level: 'top' | 'child' = 'top'): Promise<void> {
  noteCommandItemsMutation();
  const layered = await getLayeredFileSettings();
  const shared = backfillCommandIds(asCommandArray(layered.shared.custom_commands)).items;
  const localVal = layered.local.custom_commands;
  const delta: CommandTreeDelta = isCommandTreeDelta(localVal) ? localVal : {};
  const layers = { shared, delta };
  const next = level === 'child'
    ? (direction === 'to-local' ? moveChildToLocal(layers, id) : moveChildToShared(layers, id))
    : (direction === 'to-local' ? moveTopLevelToLocal(layers, id) : moveTopLevelToShared(layers, id));
  await updateFileSettingsLayer('shared', { custom_commands: next.shared });
  await persistLocalCommandDelta(next.delta);
  await loadScopedCommands();
  renderCustomCommandSettings();
  await refreshSidebarFromResolved();
}

/**
 * HS-9184 — reset a locally-overridden shared command back to the shared value
 * by dropping its entry from the local delta's `overrides` (the row's undo-2
 * affordance). No-op when there's no local override for `id`. Reloads + re-renders.
 */
export async function resetCommandOverride(id: string): Promise<void> {
  noteCommandItemsMutation();
  const layered = await getLayeredFileSettings();
  const localVal = layered.local.custom_commands;
  if (!isCommandTreeDelta(localVal) || localVal.overrides === undefined || !(id in localVal.overrides)) return;
  const nextOverrides = Object.fromEntries(Object.entries(localVal.overrides).filter(([k]) => k !== id));
  const delta: CommandTreeDelta = { ...localVal };
  if (Object.keys(nextOverrides).length > 0) delta.overrides = nextOverrides;
  else delete delta.overrides;
  await persistLocalCommandDelta(delta);
  await loadScopedCommands();
  renderCustomCommandSettings();
  await refreshSidebarFromResolved();
}

/**
 * HS-9183 — restore (unhide) a shared command hidden on this machine by dropping
 * its id from the local delta's `hidden` list, so it reappears in the resolved
 * tree. No-op if `id` isn't hidden. Reloads + re-renders + refreshes the sidebar.
 */
export async function unhideCommand(id: string): Promise<void> {
  noteCommandItemsMutation();
  const layered = await getLayeredFileSettings();
  const localVal = layered.local.custom_commands;
  if (!isCommandTreeDelta(localVal) || localVal.hidden === undefined || !localVal.hidden.includes(id)) return;
  const nextHidden = localVal.hidden.filter(h => h !== id);
  const delta: CommandTreeDelta = { ...localVal };
  if (nextHidden.length > 0) delta.hidden = nextHidden;
  else delete delta.hidden;
  await persistLocalCommandDelta(delta);
  await loadScopedCommands();
  renderCustomCommandSettings();
  await refreshSidebarFromResolved();
}

export function bindExperimentalSettings() {
  const channelCheckbox = byId<HTMLInputElement>('settings-channel-enabled');
  const channelHint = byId('settings-channel-hint');
  const channelInstructions = byId('settings-channel-instructions');
  const channelCopyBtn = byIdOrNull('settings-channel-copy-btn');
  const channelCmd = byIdOrNull('settings-channel-cmd');
  const customCommandsSection = byId('settings-custom-commands-section');

  // HS-9014 — reload the scope-aware editor tree when the dialog's scope mode
  // changes (Shared / Local / Resolved). Bound once.
  ensureCommandScopeListener();

  // Check Claude CLI and reload commands when settings open
  byId('settings-btn').addEventListener('click', () => {
    // HS-9014 — defer to a microtask so the scope control's open handler (which
    // `resetScopeMode()`s to Resolved and is registered LAST) runs first;
    // otherwise `loadScopedCommands` would read the prior session's stale mode.
    queueMicrotask(() => {
      void loadScopedCommands().then(() => {
        renderChannelCommands();
        renderCustomCommandSettings();
      });
    });

    getClaudeVersionCheck().catch(() => null).then(check => {
      if (!check || !check.installed) {
        channelCheckbox.disabled = true;
        channelHint.textContent = 'Claude Code not detected. Shell commands are still available.';
      } else if (!check.meetsMinimum) {
        channelHint.textContent = `Claude Code ${check.version ?? 'unknown'} detected but v2.1.80+ is required. Please upgrade Claude Code.`;
        channelCheckbox.disabled = true;
      } else {
        channelHint.textContent = 'Push worklist events to a running Claude Code session via MCP channels.';
        channelCheckbox.disabled = false;
      }
      customCommandsSection.style.display = '';
    }).catch(() => {
      channelCheckbox.disabled = true;
      channelHint.textContent = 'Could not check for Claude Code. Shell commands are still available.';
      customCommandsSection.style.display = '';
    });
  });

  // Load channel enabled state from global config (authoritative source)
  getGlobalConfig().catch(() => null).then(config => {
    if (config !== null) {
      const enabled = config.channelEnabled === true;
      channelCheckbox.checked = enabled;
      channelEnabledState = enabled;
      if (enabled) {
        channelInstructions.style.display = '';
      }
    }
    // Always show custom commands (shell commands work without channel)
    customCommandsSection.style.display = '';
  }).catch(() => {});

  // HS-8349 — render the per-project channel-launch command. The MCP
  // server name is now `hotsheet-channel-<slug>`; fetch it from
  // /channel/status so the command shown in Settings → Experimental
  // matches the actual launch string used by terminals + .mcp.json.
  if (channelCmd !== null) {
    getChannelStatus().catch(() => null).then(status => {
      const serverName = status?.serverName ?? 'hotsheet-channel';
      channelCmd.textContent = `claude --dangerously-load-development-channels server:${serverName}`;
    }).catch(() => {});
  }

  // Reload custom commands every time settings opens
  void reloadCustomCommands().then(() => {
    renderChannelCommands();
    renderCustomCommandSettings();
  });

  channelCheckbox.addEventListener('change', async () => {
    if (channelCheckbox.checked) {
      await enableChannel();
      channelInstructions.style.display = '';
      channelEnabledState = true;
    } else {
      await disableChannel();
      channelInstructions.style.display = 'none';
      channelEnabledState = false;
    }
    // Always keep custom commands visible (shell commands work without channel)
    customCommandsSection.style.display = '';
    renderCustomCommandSettings(); // Re-render warnings before initChannel (which is async)
    renderChannelCommands();
    void initChannel();
  });

  channelCopyBtn?.addEventListener('click', () => {
    const text = channelCmd?.textContent ?? '';
    void navigator.clipboard.writeText(text).then(() => {
      channelCopyBtn.textContent = 'Copied!';
      setTimeout(() => { channelCopyBtn.textContent = 'Copy'; }, 1500);
    });
  });

}

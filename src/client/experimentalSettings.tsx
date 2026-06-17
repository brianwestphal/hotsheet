import { disableChannel, enableChannel, getChannelStatus, getClaudeVersionCheck, getGlobalConfig, getSettings, updateSettings } from '../api/index.js';
import { initChannel } from './channelUI.js';
import { renderCustomCommandSettings } from './commandEditor.js';
import { renderChannelCommands } from './commandSidebar.js';
import { byId, byIdOrNull } from './dom.js';
// All Lucide icons loaded from generated JSON
import ALL_LUCIDE_ICONS from './lucide-icons.json';

export const CMD_ICONS: { name: string; svg: string }[] = Object.entries(ALL_LUCIDE_ICONS as Record<string, string>).map(([name, svg]) => ({ name, svg }));

export interface CustomCommand {
  name: string;
  prompt: string;
  icon?: string;
  color?: string;
  target?: 'claude' | 'shell';  // default 'claude'
  autoShowLog?: boolean;  // auto-show log entry on shell completion (always on error)
  // HS-8539 — shell only. When true, a normal click launches the command in a
  // NEW drawer terminal (default shell) instead of the inline streaming run.
  // Long-press always launches in a new terminal regardless of this flag.
  // Default false (undefined).
  launchInNewTerminal?: boolean;
}

export interface CommandGroup {
  type: 'group';
  name: string;
  collapsed?: boolean;  // persisted collapse state
  children: CustomCommand[];  // commands explicitly in this group
}

export type CommandItem = CustomCommand | CommandGroup;

export function isGroup(item: CommandItem): item is CommandGroup {
  // HS-8088 — `CommandItem` is `CustomCommand | CommandGroup`. The
  // `'type' in item` check fully narrows to `CommandGroup` since
  // `CustomCommand` has no `type` field — no follow-up `=== 'group'`
  // comparison is needed (and lint flags it as `'group' === 'group'`
  // always true). Pre-fix this read `(item as unknown as
  // Record<string, unknown>).type === 'group'` to dodge the narrowing
  // mismatch the cast had introduced; the cast is gone now.
  return 'type' in item;
}

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

/** Resolve an ItemRef to the actual CustomCommand. */
export function resolveCommand(ref: ItemRef): CustomCommand {
  if (ref.type === 'top') return commandItems[ref.index] as CustomCommand;
  return (commandItems[ref.groupIndex] as CommandGroup).children[ref.childIndex];
}

/** Update a CustomCommand in-place at the given ref. */
export function updateCommand(ref: ItemRef, updater: (cmd: CustomCommand) => void) {
  updater(resolveCommand(ref));
}

/** Delete a command or group at the given ref. */
export function deleteAtRef(ref: ItemRef) {
  if (ref.type === 'top') {
    commandItems.splice(ref.index, 1);
  } else {
    const group = commandItems[ref.groupIndex] as CommandGroup;
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
  await updateSettings({ custom_commands: JSON.stringify(commandItems) });
  renderChannelCommands();
}

export function bindExperimentalSettings() {
  const channelCheckbox = byId<HTMLInputElement>('settings-channel-enabled');
  const channelHint = byId('settings-channel-hint');
  const channelInstructions = byId('settings-channel-instructions');
  const channelCopyBtn = byIdOrNull('settings-channel-copy-btn');
  const channelCmd = byIdOrNull('settings-channel-cmd');
  const customCommandsSection = byId('settings-custom-commands-section');

  // Check Claude CLI and reload commands when settings open
  byId('settings-btn').addEventListener('click', () => {
    // Reload commands from the current project's settings
    void reloadCustomCommands().then(() => {
      renderChannelCommands();
      renderCustomCommandSettings();
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

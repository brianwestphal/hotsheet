import { api } from './api.js';
import { initChannel } from './channelUI.js';
import { renderCustomCommandSettings } from './commandEditor.js';
import { renderChannelCommands } from './commandSidebar.js';
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
}

export interface CommandGroup {
  type: 'group';
  name: string;
  collapsed?: boolean;  // persisted collapse state
  children: CustomCommand[];  // commands explicitly in this group
}

export type CommandItem = CustomCommand | CommandGroup;

export function isGroup(item: CommandItem): item is CommandGroup {
  return 'type' in item && (item as unknown as Record<string, unknown>).type === 'group';
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

/** Reload custom commands from the active project's settings. Called on project switch. */
export async function reloadCustomCommands(): Promise<void> {
  try {
    const settings = await api<Record<string, string>>('/settings');
    if (settings.custom_commands !== '') {
      try {
        const parsed = JSON.parse(settings.custom_commands) as unknown[];
        commandItems = migrateOldFormat(parsed);
      } catch { commandItems = []; }
    } else {
      commandItems = [];
    }
  } catch {
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
  await api('/settings', { method: 'PATCH', body: { custom_commands: JSON.stringify(commandItems) } });
  renderChannelCommands();
}

export function bindExperimentalSettings() {
  const channelCheckbox = document.getElementById('settings-channel-enabled') as HTMLInputElement;
  const channelHint = document.getElementById('settings-channel-hint')!;
  const channelInstructions = document.getElementById('settings-channel-instructions') as HTMLElement;
  const channelCopyBtn = document.getElementById('settings-channel-copy-btn');
  const channelCmd = document.getElementById('settings-channel-cmd');
  const customCommandsSection = document.getElementById('settings-custom-commands-section') as HTMLElement;

  // Check Claude CLI and reload commands when settings open
  document.getElementById('settings-btn')!.addEventListener('click', () => {
    // Reload commands from the current project's settings
    void reloadCustomCommands().then(() => {
      renderChannelCommands();
      renderCustomCommandSettings();
    });

    fetch('/api/channel/claude-check').then(r => r.ok ? r.json() : null).then((check: { installed: boolean; version: string | null; meetsMinimum: boolean } | null) => {
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
  fetch('/api/global-config').then(r => r.ok ? r.json() as Promise<{ channelEnabled?: boolean }> : null).then(config => {
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

  // Reload custom commands every time settings opens
  void reloadCustomCommands().then(() => {
    renderChannelCommands();
    renderCustomCommandSettings();
  });

  channelCheckbox.addEventListener('change', async () => {
    if (channelCheckbox.checked) {
      await api('/channel/enable', { method: 'POST' });
      channelInstructions.style.display = '';
      channelEnabledState = true;
    } else {
      await api('/channel/disable', { method: 'POST' });
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

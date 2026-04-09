import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { isChannelAlive, setShellBusy, triggerChannelAndMarkBusy } from './channelUI.js';
import { refreshLogBadge } from './commandLog.js';
import { toElement } from './dom.js';
import { CMD_COLORS, CMD_ICONS, type CommandItem, contrastColor, type CustomCommand, getCommandItems,isGroup } from './experimentalSettings.js';
import { renderIconSvg } from './icons.js';

function isCommandVisible(cmd: CustomCommand, channelEnabled: boolean): boolean {
  if (!cmd.name.trim() || !cmd.prompt.trim()) return false;
  const isShell = cmd.target === 'shell';
  return isShell || channelEnabled;
}

function renderButton(cmd: CustomCommand) {
  const isShell = cmd.target === 'shell';
  const color = cmd.color ?? CMD_COLORS[0].value;
  const textColor = contrastColor(color);
  const iconDef = CMD_ICONS.find(ic => ic.name === cmd.icon) || CMD_ICONS[0];
  const btn = toElement(
    <button className="channel-command-btn" style={`background:${color};color:${textColor}`}>{raw(renderIconSvg(iconDef.svg, 14, textColor))}<span>{cmd.name}</span></button>
  );
  btn.addEventListener('click', () => {
    if (isShell) {
      void runShellCommand(cmd.prompt, cmd.name, cmd.autoShowLog === true);
    } else if (!isChannelAlive()) {
      alert('Claude is not connected. Launch Claude Code with channel support first.');
    } else {
      triggerChannelAndMarkBusy(cmd.prompt);
    }
  });
  return btn;
}

export function renderChannelCommands() {
  const commandItems = getCommandItems();
  const container = document.getElementById('channel-commands-container');
  if (!container) return;
  container.innerHTML = '';

  // Check if Claude channel is enabled
  const channelSection = document.getElementById('channel-play-section');
  const channelEnabled = channelSection !== null && channelSection.style.display !== 'none';

  // Walk the top-level items and render
  for (const item of commandItems) {
    if (isGroup(item)) {
      // Check if group has any visible commands
      const hasVisibleCmd = item.children.some(child => isCommandVisible(child, channelEnabled));
      if (!hasVisibleCmd) continue;

      const isCollapsed = item.collapsed === true;
      const chevronRight = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
      const chevronDown = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
      const header = toElement(
        <div className="cmd-group-header">
          <span className="cmd-group-name">{item.name}</span>
          <span className="cmd-group-chevron">{raw(isCollapsed ? chevronRight : chevronDown)}</span>
        </div>
      );
      const body = toElement(<div className="cmd-group-body" style={isCollapsed ? 'display:none' : ''}></div>);

      const groupRef = item;
      header.addEventListener('click', () => {
        const nowCollapsed = !(groupRef.collapsed ?? false);
        groupRef.collapsed = nowCollapsed ? true : undefined;
        (header.querySelector('.cmd-group-chevron') as HTMLElement).innerHTML = nowCollapsed ? chevronRight : chevronDown;
        body.style.display = nowCollapsed ? 'none' : '';
        // Persist collapse state
        void saveCommandItemsExternal(commandItems);
      });

      // Render children into the group body
      for (const child of item.children) {
        if (!isCommandVisible(child, channelEnabled)) continue;
        body.appendChild(renderButton(child));
      }

      container.appendChild(header);
      container.appendChild(body);
    } else {
      // Top-level ungrouped command
      if (!isCommandVisible(item, channelEnabled)) continue;
      container.appendChild(renderButton(item));
    }
  }
}

/** Save command items via API and re-render sidebar. */
async function saveCommandItemsExternal(commandItems: CommandItem[]) {
  await api('/settings', { method: 'PATCH', body: { custom_commands: JSON.stringify(commandItems) } });
  renderChannelCommands();
}

// --- Shell command execution ---

let shellPollTimer: ReturnType<typeof setInterval> | null = null;
let shellAutoShowLog = false;

function startShellPoll(id: number) {
  if (shellPollTimer) clearInterval(shellPollTimer);
  shellPollTimer = setInterval(async () => {
    try {
      const { ids } = await api<{ ids: number[] }>('/shell/running');
      if (!ids.includes(id)) {
        // Process finished
        const wasAutoShow = shellAutoShowLog;

        shellAutoShowLog = false;
        if (shellPollTimer) { clearInterval(shellPollTimer); shellPollTimer = null; }
        setShellBusy(false);
        void refreshLogBadge();
        // Auto-show log entry on completion or error
        void autoShowLogEntry(id, wasAutoShow);
      }
    } catch { /* ignore */ }
  }, 2000);
}

async function autoShowLogEntry(logId: number, autoShow: boolean) {
  try {
    const entries = await api<{ id: number; summary: string }[]>('/command-log?limit=50');
    const entry = entries.find(e => e.id === logId);
    if (!entry) return;
    // Check for error: summary doesn't end with "Completed (exit 0)"
    const isError = !entry.summary.includes('Completed (exit 0)');
    if (autoShow || isError) {
      const { showLogEntryById } = await import('./commandLog.js');
      showLogEntryById(logId);
    }
  } catch { /* non-critical */ }
}

async function runShellCommand(command: string, name?: string, autoShow = false) {
  setShellBusy(true);
  shellAutoShowLog = autoShow;
  try {
    // Ensure AI tool skills are installed/up-to-date before running commands
    void api('/ensure-skills', { method: 'POST' });
    const result = await api<{ id: number }>('/shell/exec', { method: 'POST', body: { command, name } });

    startShellPoll(result.id);
    void refreshLogBadge();
  } catch {
    setShellBusy(false);
    shellAutoShowLog = false;
  }
}

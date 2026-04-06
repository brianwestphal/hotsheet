import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { initChannel, isChannelAlive, setShellBusy, triggerChannelAndMarkBusy } from './channelUI.js';
import { refreshLogBadge } from './commandLog.js';
import { toElement } from './dom.js';
import { renderIconSvg } from './icons.js';
// All Lucide icons loaded from generated JSON
import ALL_LUCIDE_ICONS from './lucide-icons.json';

const CMD_ICONS: { name: string; svg: string }[] = Object.entries(ALL_LUCIDE_ICONS as Record<string, string>).map(([name, svg]) => ({ name, svg }));

interface CustomCommand {
  name: string;
  prompt: string;
  icon?: string;
  color?: string;
  target?: 'claude' | 'shell';  // default 'claude'
  autoShowLog?: boolean;  // auto-show log entry on shell completion (always on error)
}

// Predefined color palette for command buttons
const CMD_COLORS = [
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

let customCommands: CustomCommand[] = [];

let channelEnabledState = false;

function isChannelEnabled(): boolean {
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

export function renderChannelCommands() {
  const container = document.getElementById('channel-commands-container');
  if (!container) return;
  container.innerHTML = '';

  // Check if Claude channel is enabled
  const channelSection = document.getElementById('channel-play-section');
  const channelEnabled = channelSection !== null && channelSection.style.display !== 'none';

  for (const cmd of customCommands) {
    if (!cmd.name.trim() || !cmd.prompt.trim()) continue;
    // Show shell commands always; show Claude commands only when channel is enabled
    const isShell = cmd.target === 'shell';
    if (!isShell && !channelEnabled) continue;

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
        // eslint-disable-next-line no-alert
        alert('Claude is not connected. Launch Claude Code with channel support first.');
      } else {
        triggerChannelAndMarkBusy(cmd.prompt);
      }
    });
    container.appendChild(btn);
  }
}

let shellBusyId: number | null = null;
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
        shellBusyId = null;
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
    shellBusyId = result.id;
    startShellPoll(result.id);
    void refreshLogBadge();
  } catch {
    setShellBusy(false);
    shellAutoShowLog = false;
  }
}

function showColorDropdown(anchor: HTMLElement, cmdIndex: number) {
  document.querySelectorAll('.color-dropdown-popup').forEach(p => p.remove());
  const popup = toElement(
    <div className="color-dropdown-popup">
      {CMD_COLORS.map(c =>
        <button className={`color-dropdown-item${(customCommands[cmdIndex].color ?? CMD_COLORS[0].value) === c.value ? ' active' : ''}`} data-color={c.value}>
          <span className="command-color-swatch" style={`background:${c.value}`}></span>
          <span>{c.label}</span>
        </button>
      )}
    </div>
  );
  popup.querySelectorAll('.color-dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      const color = (item as HTMLElement).dataset.color!;
      customCommands[cmdIndex] = { ...customCommands[cmdIndex], color };
      anchor.style.background = color;
      popup.remove();
      void saveCustomCommands();
    });
  });
  const rect = anchor.getBoundingClientRect();
  popup.style.position = 'fixed';
  popup.style.zIndex = '3000';
  document.body.appendChild(popup);
  // Clamp to viewport
  const popupRect = popup.getBoundingClientRect();
  let top = rect.bottom + 4;
  if (top + popupRect.height > window.innerHeight - 8) top = rect.top - popupRect.height - 4;
  popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popupRect.width - 8))}px`;
  popup.style.top = `${Math.max(8, top)}px`;
  setTimeout(() => {
    const close = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node)) { popup.remove(); document.removeEventListener('click', close); }
    };
    document.addEventListener('click', close);
  }, 0);
}

function showIconPicker(anchor: HTMLElement, cmdIndex: number) {
  // Remove any existing picker
  document.querySelectorAll('.icon-picker-popup').forEach(p => p.remove());

  const popup = toElement(
    <div className="icon-picker-popup">
      <input type="text" className="icon-picker-search" placeholder="Search icons..." />
      <div className="icon-picker-grid"></div>
    </div>
  );

  const grid = popup.querySelector('.icon-picker-grid') as HTMLElement;
  const searchInput = popup.querySelector('.icon-picker-search') as HTMLInputElement;

  const FEATURED = ['terminal', 'git-commit', 'git-branch', 'git-pull-request', 'code', 'play', 'send', 'upload', 'download', 'refresh-cw', 'check', 'save', 'rocket', 'zap', 'search', 'file-text', 'clipboard', 'trash', 'edit', 'settings', 'bug', 'test-tube', 'database', 'lock'];

  function renderIcons(filter = '') {
    grid.innerHTML = '';
    let icons: typeof CMD_ICONS;
    if (filter) {
      icons = CMD_ICONS.filter(ic => ic.name.includes(filter.toLowerCase()));
    } else {
      // Show featured icons first, then a separator, then all
      const featured = FEATURED.map(name => CMD_ICONS.find(ic => ic.name === name)).filter(Boolean) as typeof CMD_ICONS;
      const sep = toElement(<div className="icon-picker-separator"></div>);
      addIconButtons(featured);
      grid.appendChild(sep);
      icons = CMD_ICONS.filter(ic => !FEATURED.includes(ic.name));
    }
    addIconButtons(icons);
  }

  function addIconButtons(icons: typeof CMD_ICONS) {
    for (const ic of icons) {
      const btn = toElement(
        <button className={`icon-picker-item${customCommands[cmdIndex].icon === ic.name ? ' active' : ''}`} title={ic.name}>
          {raw(renderIconSvg(ic.svg, 18))}
        </button>
      );
      btn.addEventListener('click', () => {
        customCommands[cmdIndex] = { ...customCommands[cmdIndex], icon: ic.name };
        anchor.innerHTML = renderIconSvg(ic.svg, 16);
        popup.remove();
        void saveCustomCommands();
      });
      grid.appendChild(btn);
    }
  }

  renderIcons();
  searchInput.addEventListener('input', () => renderIcons(searchInput.value));

  // Position below anchor, clamped to viewport
  const rect = anchor.getBoundingClientRect();
  popup.style.position = 'fixed';
  popup.style.zIndex = '3000';
  document.body.appendChild(popup);
  const popupRect = popup.getBoundingClientRect();
  let top = rect.bottom + 4;
  if (top + popupRect.height > window.innerHeight - 8) top = rect.top - popupRect.height - 4;
  popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popupRect.width - 8))}px`;
  popup.style.top = `${Math.max(8, top)}px`;
  searchInput.focus();

  // Close on outside click
  setTimeout(() => {
    const close = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node)) { popup.remove(); document.removeEventListener('click', close); }
    };
    document.addEventListener('click', close);
  }, 0);
}

let draggedCmdIndex: number | null = null;

/** Render a single command row with all its event handlers. */
function renderCommandRow(index: number): HTMLElement {
  const cmd = customCommands[index];
  const currentIcon = CMD_ICONS.find(ic => ic.name === cmd.icon) || CMD_ICONS[0];
  const currentColor = cmd.color ?? CMD_COLORS[0].value;

  const currentTarget = cmd.target ?? 'claude';
  const promptLabel = currentTarget === 'shell' ? 'Shell command to run:' : 'Prompt sent to Claude:';
  const promptPlaceholder = currentTarget === 'shell' ? 'e.g. npm run build' : 'Tell Claude what to do...';

  const row = toElement(
    <div className="settings-command-row" draggable="true" data-cmd-index={String(index)}>
      <div className="settings-command-row-header">
        <span className="command-drag-handle" title="Drag to reorder">{'\u2630'}</span>
        <button className="command-color-dropdown-btn" title="Choose color" style={`background:${currentColor}`}></button>
        <button className="command-icon-picker-btn" title="Choose icon">{raw(renderIconSvg(currentIcon.svg, 16))}</button>
        <input type="text" value={cmd.name} placeholder="Button label..." />
        <button className="category-delete-btn" title="Remove">{'\u00d7'}</button>
      </div>
      <div className="command-target-segmented">
        <button className={`seg-btn${currentTarget === 'claude' ? ' active' : ''}`} data-target="claude">Claude Code</button>
        <button className={`seg-btn${currentTarget === 'shell' ? ' active' : ''}`} data-target="shell">Shell</button>
      </div>
      <label className="command-prompt-label">{promptLabel}</label>
      <textarea placeholder={promptPlaceholder}>{cmd.prompt}</textarea>
      <label className="command-auto-show-label" style={currentTarget === 'shell' ? '' : 'display:none'}>
        <input type="checkbox" className="command-auto-show" checked={cmd.autoShowLog === true} /> Show log on completion
      </label>
      <div className="command-claude-warning" style={currentTarget !== 'shell' && !isChannelEnabled() ? '' : 'display:none'}>
        {'\u26A0'} This command won't appear in the sidebar unless Claude Channel is enabled above.
      </div>
    </div>
  );

  const nameInput = row.querySelector('input[type="text"]') as HTMLInputElement;
  const promptArea = row.querySelector('textarea') as HTMLTextAreaElement;
  const segBtns = row.querySelectorAll('.seg-btn');
  const promptLabelEl = row.querySelector('.command-prompt-label') as HTMLElement;
  const autoShowLabel = row.querySelector('.command-auto-show-label') as HTMLElement;
  const autoShowCheckbox = row.querySelector('.command-auto-show') as HTMLInputElement;
  const claudeWarning = row.querySelector('.command-claude-warning') as HTMLElement;

  const save = () => {
    customCommands[index] = { ...customCommands[index], name: nameInput.value, prompt: promptArea.value };
    void saveCustomCommands();
  };

  nameInput.addEventListener('input', save);
  promptArea.addEventListener('input', save);

  autoShowCheckbox.addEventListener('change', () => {
    customCommands[index] = { ...customCommands[index], autoShowLog: autoShowCheckbox.checked };
    void saveCustomCommands();
  });

  for (const segBtn of segBtns) {
    segBtn.addEventListener('click', () => {
      const target = (segBtn as HTMLElement).dataset.target as 'claude' | 'shell';
      for (const b of segBtns) b.classList.remove('active');
      segBtn.classList.add('active');
      customCommands[index] = { ...customCommands[index], target: target === 'claude' ? undefined : target };
      promptLabelEl.textContent = target === 'shell' ? 'Shell command to run:' : 'Prompt sent to Claude:';
      promptArea.placeholder = target === 'shell' ? 'e.g. npm run build' : 'Tell Claude what to do...';
      autoShowLabel.style.display = target === 'shell' ? '' : 'none';
      claudeWarning.style.display = target !== 'shell' && !isChannelEnabled() ? '' : 'none';
      void saveCustomCommands();
    });
  }

  // Color dropdown
  const colorBtn = row.querySelector('.command-color-dropdown-btn') as HTMLElement;
  colorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showColorDropdown(colorBtn, index);
  });

  // Icon picker
  row.querySelector('.command-icon-picker-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    showIconPicker(row.querySelector('.command-icon-picker-btn') as HTMLElement, index);
  });

  row.querySelector('.category-delete-btn')!.addEventListener('click', () => {
    customCommands.splice(index, 1);
    renderCustomCommandSettings();
    void saveCustomCommands();
  });

  // Drag and drop reordering
  row.addEventListener('dragstart', (e) => {
    draggedCmdIndex = index;
    e.dataTransfer!.setData('text/plain', String(index));
    e.dataTransfer!.effectAllowed = 'move';
    setTimeout(() => row.classList.add('dragging'), 0);
  });
  row.addEventListener('dragend', () => { row.classList.remove('dragging'); draggedCmdIndex = null; });
  row.addEventListener('dragover', (e) => {
    if (draggedCmdIndex === null) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';
    row.classList.add('drop-target');
  });
  row.addEventListener('dragleave', () => { row.classList.remove('drop-target'); });
  row.addEventListener('drop', (e) => {
    e.preventDefault();
    row.classList.remove('drop-target');
    if (draggedCmdIndex === null || draggedCmdIndex === index) return;
    const [moved] = customCommands.splice(draggedCmdIndex, 1);
    customCommands.splice(index, 0, moved);
    draggedCmdIndex = null;
    renderCustomCommandSettings();
    void saveCustomCommands();
  });

  return row;
}

function renderCustomCommandSettings() {
  const list = document.getElementById('settings-commands-list');
  if (!list) return;
  list.innerHTML = '';

  for (let i = 0; i < customCommands.length; i++) {
    list.appendChild(renderCommandRow(i));
  }
}

async function saveCustomCommands() {
  await api('/settings', { method: 'PATCH', body: { custom_commands: JSON.stringify(customCommands) } });
  renderChannelCommands();
}

export function bindExperimentalSettings() {
  const channelCheckbox = document.getElementById('settings-channel-enabled') as HTMLInputElement;
  const channelHint = document.getElementById('settings-channel-hint')!;
  const channelInstructions = document.getElementById('settings-channel-instructions') as HTMLElement;
  const channelCopyBtn = document.getElementById('settings-channel-copy-btn');
  const channelCmd = document.getElementById('settings-channel-cmd');
  const customCommandsSection = document.getElementById('settings-custom-commands-section') as HTMLElement;

  // Check Claude CLI when settings open
  document.getElementById('settings-btn')!.addEventListener('click', () => {
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
      renderCustomCommandSettings();
    }).catch(() => {
      channelCheckbox.disabled = true;
      channelHint.textContent = 'Could not check for Claude Code. Shell commands are still available.';
      customCommandsSection.style.display = '';
      renderCustomCommandSettings();
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

  // Load custom commands from settings
  void api<Record<string, string>>('/settings').then(settings => {
    if (settings.custom_commands !== '') {
      try { customCommands = JSON.parse(settings.custom_commands) as CustomCommand[]; } catch { /* ignore */ }
    }
    renderChannelCommands();
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

  // Add command button — default to Shell when channel is disabled
  document.getElementById('settings-add-command-btn')?.addEventListener('click', () => {
    const defaultTarget = channelCheckbox.checked ? undefined : 'shell' as const;
    customCommands.push({ name: '', prompt: '', target: defaultTarget });
    renderCustomCommandSettings();
  });
}

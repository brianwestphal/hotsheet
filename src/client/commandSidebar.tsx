import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { isChannelAlive, setShellBusy, triggerChannelAndMarkBusy } from './channelUI.js';
import { refreshLogBadge } from './commandLog.js';
import { toElement } from './dom.js';
import { CMD_COLORS, CMD_ICONS, type CommandItem, contrastColor, type CustomCommand, getCommandItems,isGroup } from './experimentalSettings.js';
import { renderIconSvg } from './icons.js';
import { state } from './state.js';
import { showToast } from './toast.js';

/**
 * HS-7983 — typed detail of the partial-output stream event dispatched
 * from `startShellPoll` whenever a running shell command's partial buffer
 * grew since the last poll tick. Consumers (`renderShellPartialPreview`
 * here in the sidebar AND the Commands Log live-render listener in
 * `commandLog.tsx`) gate on `id` equality and update their DOM
 * accordingly. Exported so the test suite + the listeners can share the
 * shape declaration.
 */
export interface ShellPartialOutputEvent {
  id: number;
  partial: string;
}

/** Event name; centralised so callers don't typo-drift the string. */
export const SHELL_PARTIAL_OUTPUT_EVENT = 'hotsheet:shell-partial-output';

/**
 * HS-7984 — first-use toast persistence key. Lives in `localStorage` so
 * the toast appears at most once across reloads + projects (it's a
 * one-time discoverability nudge, not a per-project notice). Set on
 * either user dismiss OR the toast's auto-fade timer; either way means
 * the user got the message.
 */
const SHELL_STREAM_TOAST_DISMISSED_KEY = 'hotsheet:shell-stream-toast-dismissed';

/**
 * HS-7984 — fire the first-use discoverability toast on the very first
 * `hotsheet:shell-partial-output` event a session sees, IF the streaming
 * setting is on AND the user hasn't already seen it (localStorage
 * sentinel). HS-8015 moved the call site from the (now-removed) sidebar
 * preview into the Commands Log live-render path, since that's where the
 * streaming output is visible. Toast text mentions the Commands Log so
 * users know where to look. Idempotent — subsequent events no-op via the
 * sentinel check. Exported so the unit tests can drive the path without
 * dispatching real events.
 */
export function maybeFireShellStreamFirstUseToast(): void {
  if (!state.settings.shell_streaming_enabled) return;
  try {
    if (window.localStorage.getItem(SHELL_STREAM_TOAST_DISMISSED_KEY) !== null) return;
    window.localStorage.setItem(SHELL_STREAM_TOAST_DISMISSED_KEY, String(Date.now()));
  } catch { /* localStorage disabled — fall through and show the toast anyway, no harm */ }
  showToast('Shell command output now streams live in the Commands Log — Settings → Experimental to disable.', { durationMs: 7000 });
}

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
/**
 * HS-7983 — per-running-id last-seen partial buffer length. The poll
 * adapter only dispatches a `hotsheet:shell-partial-output` event when
 * the partial actually grew, so a stalled command (no new output between
 * ticks) doesn't re-render preview elements every 2 s. Cleared when the
 * id leaves `/api/shell/running`'s `ids` array.
 */
const lastSeenPartialLength = new Map<number, number>();

/** Pure helper exported for tests. Decides which `{id, partial}` pairs
 *  should be dispatched as `hotsheet:shell-partial-output` events given
 *  the current `/api/shell/running` response and the per-id last-seen
 *  length cache. Returns the events to dispatch + the next cache state.
 *  No DOM, no network — happy-dom doesn't even need to load.
 *
 *  - A dispatch fires for every running id whose partial length grew.
 *  - The cache is rewritten to drop ids that are no longer running.
 *  - Backwards-compat: `outputs` may be missing / empty when the server
 *    hasn't exposed the field yet (older servers); we still update
 *    completion bookkeeping but emit no events. */
export function decideShellPartialEvents(
  response: { ids: readonly number[]; outputs?: Record<number, string> },
  cache: ReadonlyMap<number, number>,
): { events: ShellPartialOutputEvent[]; nextCache: Map<number, number> } {
  const events: ShellPartialOutputEvent[] = [];
  const nextCache = new Map<number, number>();
  const outputs = response.outputs ?? {};
  for (const id of response.ids) {
    const partial = outputs[id];
    if (partial === undefined) {
      // No output yet for this id — preserve any prior length so a
      // resumed-mid-flight client doesn't re-emit the whole buffer when
      // the next chunk arrives.
      const prev = cache.get(id);
      if (prev !== undefined) nextCache.set(id, prev);
      continue;
    }
    const lastLen = cache.get(id) ?? 0;
    if (partial.length > lastLen) {
      events.push({ id, partial });
    }
    nextCache.set(id, partial.length);
  }
  return { events, nextCache };
}

function startShellPoll(id: number) {
  if (shellPollTimer) clearInterval(shellPollTimer);
  shellPollTimer = setInterval(async () => {
    try {
      const response = await api<{ ids: number[]; outputs?: Record<number, string> }>('/shell/running');
      // HS-7983 — fan out partial-output events to the Commands Log live
      // render (HS-8015 removed the sidebar row preview). Dedupe via the
      // per-id length cache so a stalled command doesn't thrash the DOM.
      const { events, nextCache } = decideShellPartialEvents(response, lastSeenPartialLength);
      lastSeenPartialLength.clear();
      for (const [k, v] of nextCache) lastSeenPartialLength.set(k, v);
      for (const ev of events) {
        window.dispatchEvent(new CustomEvent<ShellPartialOutputEvent>(SHELL_PARTIAL_OUTPUT_EVENT, { detail: ev }));
      }

      if (!response.ids.includes(id)) {
        // Process finished
        const wasAutoShow = shellAutoShowLog;

        shellAutoShowLog = false;
        if (shellPollTimer) { clearInterval(shellPollTimer); shellPollTimer = null; }
        // HS-7983 — drop the cache entry; a future re-run with the same
        // id (rare, would require log-id reuse) starts from zero.
        lastSeenPartialLength.delete(id);
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

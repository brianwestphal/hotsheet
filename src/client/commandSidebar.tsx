import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { isChannelAlive, setShellBusy, triggerChannelAndMarkBusy } from './channelUI.js';
import { refreshLogBadge } from './commandLog.js';
import { confirmDialog } from './confirm.js';
import { toElement } from './dom.js';
import { CMD_COLORS, CMD_ICONS, type CommandItem, contrastColor, type CustomCommand, getCommandItems,isGroup } from './experimentalSettings.js';
import { renderIconSvg } from './icons.js';
import { getActiveProject, state } from './state.js';
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

/**
 * HS-8060 — derive a stable lookup key for a CustomCommand. CustomCommand
 * has no id field, so the key is a tuple of `(target, name, prompt)` —
 * that's what uniquely identifies a button shape from the user's saved
 * `custom_commands` list. Two commands with identical name + prompt
 * would share state; that's the documented edge case from §57.3.5.
 */
export function commandKey(cmd: CustomCommand): string {
  const target = cmd.target ?? 'claude';
  return `${target}::${cmd.name}::${cmd.prompt}`;
}

/**
 * HS-8060 — `commandKey → /api/shell/exec`-returned log id for every
 * shell command that's currently running. Updated synchronously when
 * `runShellCommand` succeeds (added) and on every `/api/shell/running`
 * poll tick (entries dropped when their id no longer appears in
 * `response.ids`). The size doubles as the global busy-state input
 * (`setShellBusy(runningButtons.size > 0)`).
 *
 * HS-8070 — keys are now `${secret}::${commandKey(cmd)}` so a running
 * command in Project A doesn't make Project B's identically-named
 * button show the spinner after the user switches projects. Pre-fix
 * the map was keyed by `commandKey(cmd)` alone — two projects with
 * the same name+prompt button collided on lookup, and the spinner
 * "kept showing on different project after switching" (the user's
 * exact symptom). Read/write helpers below build the composite key
 * from `getActiveProject()`'s secret; the poll loop continues to drop
 * entries by id (still global on the server side, see /shell/running)
 * so cross-project bookkeeping stays consistent — entries for
 * non-active projects survive across switches and the spinner shows
 * again when the user returns to the originating project.
 *
 * Exported for tests + Phase 2 callers; production consumers go through
 * `renderChannelCommands` which reads it during render.
 */
export const _runningButtonsForTesting = new Map<string, number>();

/** HS-8070 — composite key for the per-project runningButtons map.
 *  `secret` may be empty during boot before `setActiveProject` fires —
 *  the empty-secret namespace is a benign isolation for that window. */
export function runningKey(secret: string, cmd: CustomCommand): string {
  return `${secret}::${commandKey(cmd)}`;
}

/** HS-8060 — per-running-id "auto-show on completion" flag. Replaces the
 *  pre-fix global `shellAutoShowLog: boolean` which raced when the user
 *  kicked off two commands with different `autoShowLog` values back-to-
 *  back (the second flag clobbered the first). */
const autoShowLogById = new Map<number, boolean>();

const STOP_GLYPH = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="14" x="5" y="5" rx="1"/></svg>';

function buildSpinnerElement(textColor: string): HTMLElement {
  // 14×14 spinner ring + an 8×8 stop glyph centered inside. Both inherit
  // the spinner's foreground colour (the button's `contrastColor`); the
  // spinner element itself uses `background: inherit` so it picks up the
  // button's background — see §57.3.2.
  return toElement(
    <span className="channel-command-btn-spinner" style={`color:${textColor}`} aria-hidden="true">
      <span className="channel-command-btn-spinner-ring"></span>
      <span className="channel-command-btn-spinner-stop">{raw(STOP_GLYPH)}</span>
    </span>
  );
}

function renderButton(cmd: CustomCommand) {
  const isShell = cmd.target === 'shell';
  const color = cmd.color ?? CMD_COLORS[0].value;
  const textColor = contrastColor(color);
  const iconDef = CMD_ICONS.find(ic => ic.name === cmd.icon) || CMD_ICONS[0];
  // HS-8070 — composite key includes the active project's secret so a
  // running command in another project doesn't make this button show
  // the spinner. The data-attribute keeps the unscoped `commandKey` for
  // any DOM consumers that want a project-stable identity.
  const activeSecret = getActiveProject()?.secret ?? '';
  const cmdKey = commandKey(cmd);
  const lookupKey = runningKey(activeSecret, cmd);
  const isRunning = isShell && _runningButtonsForTesting.has(lookupKey);
  const btn = toElement(
    <button
      className={`channel-command-btn${isRunning ? ' is-running' : ''}`}
      style={`background:${color};color:${textColor}`}
      data-command-key={cmdKey}
    >{raw(renderIconSvg(iconDef.svg, 14, textColor))}<span>{cmd.name}</span></button>
  );
  if (isRunning) btn.appendChild(buildSpinnerElement(textColor));
  btn.addEventListener('click', () => {
    if (isShell) {
      const runningId = _runningButtonsForTesting.get(lookupKey);
      if (runningId !== undefined) {
        void confirmStopShellCommand(cmd, runningId);
        return;
      }
      void runShellCommand(cmd, cmd.autoShowLog === true);
    } else if (!isChannelAlive()) {
      alert('Claude is not connected. Launch Claude Code with channel support first.');
    } else {
      triggerChannelAndMarkBusy(cmd.prompt);
    }
  });
  return btn;
}

/**
 * HS-8060 — opens the §57.3.3 confirm dialog when the user clicks a
 * running command's button. On Stop fires `POST /api/shell/kill`; the
 * next poll tick will report the id has cleared from
 * `/api/shell/running` and `startShellPoll` will drop the runningButtons
 * entry + re-render. On Cancel (`Keep running`) the call is a no-op —
 * the spinner stays.
 */
async function confirmStopShellCommand(cmd: CustomCommand, runningLogId: number): Promise<void> {
  const ok = await confirmDialog({
    title: 'Stop running command?',
    message: `"${cmd.name}" is still running. Stop it now?`,
    confirmLabel: 'Stop',
    cancelLabel: 'Keep running',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('/shell/kill', { method: 'POST', body: { id: runningLogId } });
  } catch {
    // Best-effort. The poll tick will eventually catch up either way —
    // if the kill failed, the id stays in `/api/shell/running` and the
    // button stays in its running state until the user retries.
  }
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
    // HS-8093 — TS sees `outputs[id]` as `string` (project doesn't enable
    // `noUncheckedIndexedAccess`) so a direct `outputs[id] === undefined`
    // check trips lint's `no-unnecessary-condition`. `Object.hasOwn` is a
    // cleaner runtime presence check that doesn't depend on the indexed
    // access type — and matches what the comment-block actually meant
    // ("no output yet for this id").
    if (!Object.hasOwn(outputs, id)) {
      // No output yet for this id — preserve any prior length so a
      // resumed-mid-flight client doesn't re-emit the whole buffer when
      // the next chunk arrives.
      const prev = cache.get(id);
      if (prev !== undefined) nextCache.set(id, prev);
      continue;
    }
    const partial = outputs[id];
    const lastLen = cache.get(id) ?? 0;
    if (partial.length > lastLen) {
      events.push({ id, partial });
    }
    nextCache.set(id, partial.length);
  }
  return { events, nextCache };
}

/**
 * HS-8060 — single shared poll that watches every entry in
 * `_runningButtonsForTesting`. Started by `runShellCommand` after
 * adding to the map; stopped by the tick body when the map empties.
 *
 * Pre-fix the timer was per-command and `runShellCommand` would clear
 * the previous timer when a second command fired — so concurrent
 * commands silently lost partial-output streaming for the first one
 * AND raced their completion handlers. The new shape supports the
 * §57.3.4 concurrency model and the global `setShellBusy` is wired to
 * `runningButtons.size > 0` rather than a per-command boolean.
 */
function startShellPoll(): void {
  if (shellPollTimer !== null) return;
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

      // HS-8060 — drop completed runningButtons entries + fire the
      // per-id auto-show + per-id log-badge refresh. Re-render the
      // sidebar exactly once if anything changed so the affected
      // buttons drop the spinner.
      const stillRunning = new Set(response.ids);
      const completedIds: number[] = [];
      for (const [key, id] of _runningButtonsForTesting) {
        if (!stillRunning.has(id)) {
          completedIds.push(id);
          _runningButtonsForTesting.delete(key);
          // HS-7983 — drop the per-id partial-output cache entry too.
          lastSeenPartialLength.delete(id);
        }
      }
      if (completedIds.length > 0) {
        for (const id of completedIds) {
          const wasAutoShow = autoShowLogById.get(id) === true;
          autoShowLogById.delete(id);
          void autoShowLogEntry(id, wasAutoShow);
        }
        void refreshLogBadge();
        renderChannelCommands();
      }

      if (_runningButtonsForTesting.size === 0) {
        if (shellPollTimer !== null) { clearInterval(shellPollTimer); shellPollTimer = null; }
        setShellBusy(false);
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

async function runShellCommand(cmd: CustomCommand, autoShow = false): Promise<void> {
  setShellBusy(true);
  try {
    // Ensure AI tool skills are installed/up-to-date before running commands
    void api('/ensure-skills', { method: 'POST' });
    const result = await api<{ id: number }>('/shell/exec', { method: 'POST', body: { command: cmd.prompt, name: cmd.name } });
    // HS-8060 — register this run in the per-button state map BEFORE
    // re-rendering so the new render picks up the spinner. The poll
    // tick will drop the entry once the id leaves /api/shell/running.
    // HS-8070 — composite key (`${secret}::${commandKey}`) so the
    // running entry is bound to the project that started the command.
    const activeSecret = getActiveProject()?.secret ?? '';
    _runningButtonsForTesting.set(runningKey(activeSecret, cmd), result.id);
    autoShowLogById.set(result.id, autoShow);
    renderChannelCommands();
    startShellPoll();
    void refreshLogBadge();
  } catch {
    // The exec POST failed — bail without touching runningButtons.
    if (_runningButtonsForTesting.size === 0) setShellBusy(false);
  }
}

/** HS-8060 — drop every running-button entry without going through
 *  /api/shell/kill. Test-only; production never calls this (the poll
 *  drives entry removal). */
export function _resetRunningButtonsForTesting(): void {
  _runningButtonsForTesting.clear();
  autoShowLogById.clear();
  if (shellPollTimer !== null) { clearInterval(shellPollTimer); shellPollTimer = null; }
}

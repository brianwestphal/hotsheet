import { type ChannelTriggerTarget, createTicket, ensureSkills, execShellCommand, getCommandLog, getRunningShellCommands, getWorkerPool, killShellCommand, type WorkerSlotView } from '../api/index.js';
import type { SafeHtml } from '../jsx-runtime.js';
import { workerTargetWarning } from '../workers/triggerTarget.js';
import { isChannelAlive, setShellBusy, triggerChannelAndMarkBusy } from './channelUI.js';
import { isGroupCollapsed, setGroupCollapsed } from './commandGroupCollapse.js';
import { refreshLogBadge } from './commandLog.js';
import { getCommandLastRun, recordCommandRun } from './commandRunTimes.js';
import { hideCommandTooltip, showCommandTooltip } from './commandTooltip.js';
import { confirmDialog } from './confirm.js';
import { byIdOrNull, toElement } from './dom.js';
import { closeAllMenus, createDropdown, type DropdownItem, positionDropdown } from './dropdown.js';
import { CMD_COLORS, CMD_ICONS, contrastColor, type CustomCommand, getCommandItems,isGroup } from './experimentalSettings.js';
import { renderIconSvg } from './icons.js';
import { getActiveProject } from './state.js';
import { showToast } from './toast.js';

/**
 * HS-8539 — first-use discoverability key for the long-press hint. One-time
 * across reloads + projects, like `SHELL_STREAM_TOAST_DISMISSED_KEY`.
 */
const SHELL_LONGPRESS_HINT_KEY = 'hotsheet:shell-longpress-hint-shown';

/**
 * HS-8539 — the first time the user presses ANY custom shell-command button
 * (a normal click, not a long-press — if they long-pressed they already know),
 * show a one-time toast teaching the long-press → new-terminal gesture.
 * Idempotent via the localStorage sentinel. Exported for tests.
 */
export function maybeFireShellLongPressHintToast(): void {
  try {
    if (window.localStorage.getItem(SHELL_LONGPRESS_HINT_KEY) !== null) return;
    window.localStorage.setItem(SHELL_LONGPRESS_HINT_KEY, String(Date.now()));
  } catch { /* localStorage disabled — fall through and show once this session */ }
  showToast('Tip: long-press a shell command button to run it in its own new terminal instead.', { durationMs: 7000 });
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

const STOP_GLYPH: SafeHtml = (
  <svg xmlns="http://www.w3.org/2000/svg" width="8" height="8" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect width="14" height="14" x="5" y="5" rx="1"/>
  </svg>
);

const CHEVRON_RIGHT: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>;
const CHEVRON_DOWN: SafeHtml = <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>;

function buildSpinnerElement(textColor: string): HTMLElement {
  // 14×14 spinner ring + an 8×8 stop glyph centered inside. Both inherit
  // the spinner's foreground color (the button's `contrastColor`); the
  // spinner element itself uses `background: inherit` so it picks up the
  // button's background — see §57.3.2.
  return toElement(
    <span className="channel-command-btn-spinner" style={`color:${textColor}`} aria-hidden="true">
      <span className="channel-command-btn-spinner-ring"></span>
      <span className="channel-command-btn-spinner-stop">{STOP_GLYPH}</span>
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
    >{renderIconSvg(iconDef.svg, 14, textColor)}<span>{cmd.name}</span></button>
  );
  if (isRunning) btn.appendChild(buildSpinnerElement(textColor));
  // HS-8398 / HS-8847 — show a styled hover tooltip with the command's name,
  // its command text, and last-run time. Computed on `mouseenter` (not at
  // render) so the relative time is fresh every hover.
  btn.addEventListener('mouseenter', () => {
    showCommandTooltip(btn, { name: cmd.name, command: cmd.prompt, lastRunIso: getCommandLastRun(lookupKey) });
  });
  btn.addEventListener('mouseleave', hideCommandTooltip);
  // Dismiss the tooltip the moment a press starts so it doesn't linger over the
  // long-press action (open terminal / make ticket / inline run).
  btn.addEventListener('pointerdown', hideCommandTooltip);
  if (isShell) {
    wireShellButtonPress(btn, cmd, lookupKey);
  } else {
    wireClaudeButtonPress(btn, cmd);
    // HS-9083 (docs/103) — opt-in "Run on…" chevron → the target picker (Main /
    // a worker / All workers). Single-click on the button body stays Main.
    appendClaudeTargetChevron(btn, cmd);
  }
  return btn;
}

/** HS-8539 — long-press threshold for the "run in a new terminal" gesture. */
const LONG_PRESS_MS = 500;

/**
 * HS-8539 — wire a shell command button's press behavior:
 * - **Long-press (≥500 ms)** → ALWAYS run in a new drawer terminal (default
 *   shell), and suppress the click that follows the release.
 * - **Normal click** → run the running-stop confirm if it's already running;
 *   else, if the command has `launchInNewTerminal`, run in a new terminal;
 *   else the inline streaming run. The first normal click ever also fires the
 *   one-time long-press discoverability toast.
 *
 * Option B (HS-8539): long-press is always new-terminal — when
 * `launchInNewTerminal` is on, a click already does that, so long-press is
 * simply redundant (not an inverse).
 */
function wireShellButtonPress(btn: HTMLElement, cmd: CustomCommand, lookupKey: string): void {
  let pressTimer: number | null = null;
  let longPressed = false;
  const clearPressTimer = (): void => {
    if (pressTimer !== null) { clearTimeout(pressTimer); pressTimer = null; }
    btn.classList.remove('is-long-pressing');
  };
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // primary button only
    longPressed = false;
    btn.classList.add('is-long-pressing');
    pressTimer = window.setTimeout(() => {
      pressTimer = null;
      longPressed = true;
      btn.classList.remove('is-long-pressing');
      void runShellInNewTerminal(cmd);
    }, LONG_PRESS_MS);
  });
  btn.addEventListener('pointerup', clearPressTimer);
  btn.addEventListener('pointerleave', clearPressTimer);
  btn.addEventListener('pointercancel', clearPressTimer);
  btn.addEventListener('click', (e) => {
    // Long-press already acted on pointerdown's timer — swallow the trailing click.
    if (longPressed) { longPressed = false; e.preventDefault(); e.stopPropagation(); return; }
    maybeFireShellLongPressHintToast();
    const runningId = _runningButtonsForTesting.get(lookupKey);
    if (runningId !== undefined) {
      void confirmStopShellCommand(cmd, runningId);
      return;
    }
    if (cmd.launchInNewTerminal === true) {
      void runShellInNewTerminal(cmd);
      return;
    }
    void runShellCommand(cmd, cmd.autoShowLog === true);
  });
}

/**
 * HS-8538 — first-use discoverability key for the Claude-button long-press
 * hint. One-time across reloads + projects.
 */
const CLAUDE_LONGPRESS_HINT_KEY = 'hotsheet:claude-longpress-hint-shown';

/**
 * HS-8538 — the first time the user does a normal click on any custom Claude
 * command button, show a one-time toast teaching the long-press → make-a-task
 * gesture. Idempotent via the localStorage sentinel. Doesn't fire on a
 * long-press (they already know the gesture). Exported for tests.
 */
export function maybeFireClaudeLongPressHintToast(): void {
  try {
    if (window.localStorage.getItem(CLAUDE_LONGPRESS_HINT_KEY) !== null) return;
    window.localStorage.setItem(CLAUDE_LONGPRESS_HINT_KEY, String(Date.now()));
  } catch { /* localStorage disabled — fall through and show once this session */ }
  showToast('Tip: long-press a Claude command button to make a task from it instead of running it.', { durationMs: 7000 });
}

/**
 * HS-8538 — create a Task ticket from a custom Claude command instead of
 * sending it to the channel. The ticket's title is the command name and its
 * details are the command's prompt (the text that would otherwise be sent to
 * Claude). Category is always `task` (shortLabel "TSK") — a free-string column,
 * so it's stored even if the project removed `task` from its configured
 * category list (per the user's request). Reloads the list so the new ticket
 * shows immediately.
 */
async function makeTaskFromClaudeCommand(cmd: CustomCommand): Promise<void> {
  try {
    await createTicket({ title: cmd.name, defaults: { category: 'task', details: cmd.prompt } });
    showToast(`Created a task from "${cmd.name}".`, { variant: 'success' });
    const { loadTickets } = await import('./ticketList.js');
    void loadTickets();
  } catch {
    showToast('Could not create a task from that command.', { variant: 'warning' });
  }
}

/**
 * HS-8538 — wire a Claude command button's press behavior:
 * - **Long-press (≥500 ms)** → make a Task ticket from the command (and
 *   suppress the trailing click so it isn't ALSO sent to the channel).
 * - **Normal click** → the existing behavior (send the prompt to the channel,
 *   or a warning toast when Claude isn't connected). The first normal click
 *   ever also fires the one-time long-press discoverability toast.
 *
 * Mirrors the shell button's `wireShellButtonPress` (HS-8539); long-press is
 * always the make-a-task action.
 */
function wireClaudeButtonPress(btn: HTMLElement, cmd: CustomCommand): void {
  let pressTimer: number | null = null;
  let longPressed = false;
  const clearPressTimer = (): void => {
    if (pressTimer !== null) { clearTimeout(pressTimer); pressTimer = null; }
    btn.classList.remove('is-long-pressing');
  };
  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return; // primary button only
    longPressed = false;
    btn.classList.add('is-long-pressing');
    pressTimer = window.setTimeout(() => {
      pressTimer = null;
      longPressed = true;
      btn.classList.remove('is-long-pressing');
      void makeTaskFromClaudeCommand(cmd);
    }, LONG_PRESS_MS);
  });
  btn.addEventListener('pointerup', clearPressTimer);
  btn.addEventListener('pointerleave', clearPressTimer);
  btn.addEventListener('pointercancel', clearPressTimer);
  btn.addEventListener('click', (e) => {
    if (longPressed) { longPressed = false; e.preventDefault(); e.stopPropagation(); return; }
    maybeFireClaudeLongPressHintToast();
    if (!isChannelAlive()) {
      // HS-8538 — in-app toast (not window.alert, which WKWebView no-ops).
      showToast('Claude is not connected. Launch Claude Code with channel support first.', { variant: 'warning' });
    } else {
      recordCommandRun(runningKey(getActiveProject()?.secret ?? '', cmd)); // HS-8398
      triggerChannelAndMarkBusy(cmd.prompt);
    }
  });
}

/**
 * HS-9083 (docs/103 §103.3) — build the "Run on…" target-picker menu items for a
 * Claude command: **Main**, then each live worker (with a `• busy` hint when it
 * holds a claim), then **All workers**. Workers in a terminal state (`dead` /
 * `stopped`) can't receive a trigger, so they're filtered out; when none remain,
 * an informational "No workers running" row is shown. Pure (returns plain
 * `DropdownItem`s) so the labels + per-item targets are unit-testable. `run` is
 * invoked with the chosen `ChannelTriggerTarget`.
 */
export function buildTargetMenuItems(
  workers: WorkerSlotView[],
  run: (target: ChannelTriggerTarget) => void,
): DropdownItem[] {
  const items: DropdownItem[] = [
    { label: 'Main', key: '', action: () => { run({ kind: 'main' }); } },
  ];
  const targetable = workers.filter(w => w.state !== 'dead' && w.state !== 'stopped');
  if (targetable.length === 0) {
    items.push({ label: '', key: '', separator: true, action: () => { /* separator */ } });
    items.push({ label: 'No workers running', key: '', action: () => { /* informational row */ } });
    return items;
  }
  items.push({ label: '', key: '', separator: true, action: () => { /* separator */ } });
  for (const w of targetable) {
    const label = w.state === 'working' ? `${w.label} • busy` : w.label;
    items.push({ label, key: '', action: () => { run({ kind: 'worker', worktree: w.worktreePath }); } });
  }
  items.push({ label: '', key: '', separator: true, action: () => { /* separator */ } });
  items.push({ label: 'All workers', key: '', action: () => { run({ kind: 'all-workers' }); } });
  return items;
}

/**
 * HS-9083 — send a Claude command to `target`, warning first when it would
 * interrupt a busy worker (the §103.2 autonomy caution — `workerTargetWarning`).
 * `main` never warns (the normal path). Exported for tests.
 */
export async function runClaudeCommandOnTarget(
  cmd: CustomCommand,
  target: ChannelTriggerTarget,
  workers: WorkerSlotView[],
): Promise<void> {
  if (!isChannelAlive()) {
    // Same guard as a normal button click — the picker can be opened/previewed
    // before Claude connects, but firing needs a live channel.
    showToast('Claude is not connected. Launch Claude Code with channel support first.', { variant: 'warning' });
    return;
  }
  // HS-9102 — a command marked worker-safe (idempotent / maintenance) suppresses
  // the busy-worker confirm so it can fan out mid-task without prompting.
  const warning = workerTargetWarning(target, workers, { workerSafe: cmd.workerSafe });
  if (warning.warn) {
    const ok = await confirmDialog({
      title: 'Trigger a busy worker?',
      message: warning.reason,
      confirmLabel: 'Send anyway',
      cancelLabel: 'Cancel',
      danger: true,
    });
    if (!ok) return;
  }
  recordCommandRun(runningKey(getActiveProject()?.secret ?? '', cmd));
  triggerChannelAndMarkBusy(cmd.prompt, target);
}

/**
 * HS-9083 — open the target picker anchored to a command button's chevron.
 * Fetches the live worker pool on open (no extra polling loop); falls back to a
 * Main-only menu if the pool is unreachable. The picker can be previewed before
 * Claude connects — the not-connected guard is at selection time
 * (`runClaudeCommandOnTarget`), not here.
 */
async function openClaudeTargetPicker(anchor: HTMLElement, cmd: CustomCommand): Promise<void> {
  closeAllMenus();
  let workers: WorkerSlotView[] = [];
  try { workers = (await getWorkerPool()).workers; }
  catch { /* pool unreachable — still offer Main */ }
  const items = buildTargetMenuItems(workers, (target) => { void runClaudeCommandOnTarget(cmd, target, workers); });
  const menu = createDropdown(anchor, items);
  document.body.appendChild(menu);
  positionDropdown(menu, anchor);
  menu.style.visibility = '';
}

/**
 * HS-9083 — append the subtle "Run on…" chevron to a Claude command button. It
 * stops propagation on pointerdown/click so it never starts the §83 long-press
 * timer or fires the button's main (Main-target) click — single-click on the
 * button body is unchanged. The chevron is hover/focus-revealed via CSS, so the
 * no-interaction look (and the no-workers case) is untouched.
 */
function appendClaudeTargetChevron(btn: HTMLElement, cmd: CustomCommand): void {
  const chevron = toElement(<span className="cmd-target-chevron" title="Run on…">▾</span>);
  chevron.setAttribute('role', 'button');
  chevron.setAttribute('tabindex', '0');
  chevron.setAttribute('aria-label', `Choose where to run ${cmd.name}`);
  const open = (): void => { void openClaudeTargetPicker(chevron, cmd); };
  chevron.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
  chevron.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); open(); });
  chevron.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); open(); }
  });
  btn.appendChild(chevron);
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
    title: 'Stop Running Command?',
    message: `"${cmd.name}" is still running. Stop it now?`,
    confirmLabel: 'Stop',
    cancelLabel: 'Keep Running',
    danger: true,
  });
  if (!ok) return;
  try {
    await killShellCommand(runningLogId);
  } catch {
    // Best-effort. The poll tick will eventually catch up either way —
    // if the kill failed, the id stays in `/api/shell/running` and the
    // button stays in its running state until the user retries.
  }
}

export function renderChannelCommands() {
  const commandItems = getCommandItems();
  const container = byIdOrNull('channel-commands-container');
  if (!container) return;
  container.innerHTML = '';

  // Check if Claude channel is enabled
  const channelSection = byIdOrNull('channel-play-section');
  const channelEnabled = channelSection !== null && channelSection.style.display !== 'none';

  // Walk the top-level items and render
  for (const item of commandItems) {
    if (isGroup(item)) {
      // Check if group has any visible commands
      const hasVisibleCmd = item.children.some(child => isCommandVisible(child, channelEnabled));
      if (!hasVisibleCmd) continue;

      // HS-9095 — collapse is a per-device display preference, persisted in
      // localStorage (NOT the command tree → no shared write that would leak a
      // local delta; see `commandGroupCollapse.ts`).
      const collapseSecret = getActiveProject()?.secret ?? '';
      const isCollapsed = isGroupCollapsed(collapseSecret, item);
      const header = toElement(
        <div className="cmd-group-header">
          <span className="cmd-group-name">{item.name}</span>
          <span className="cmd-group-chevron">{isCollapsed ? CHEVRON_RIGHT : CHEVRON_DOWN}</span>
        </div>
      );
      const body = toElement(<div className="cmd-group-body" style={isCollapsed ? 'display:none' : ''}></div>);

      const groupRef = item;
      header.addEventListener('click', () => {
        const nowCollapsed = !isGroupCollapsed(collapseSecret, groupRef);
        setGroupCollapsed(collapseSecret, groupRef, nowCollapsed);
        const chevronHost = header.querySelector('.cmd-group-chevron')!;
        chevronHost.replaceChildren(toElement(nowCollapsed ? CHEVRON_RIGHT : CHEVRON_DOWN));
        body.style.display = nowCollapsed ? 'none' : '';
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

// --- Shell command execution ---

let shellPollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * HS-8060 — single shared poll that watches every entry in
 * `_runningButtonsForTesting`. Started by `runShellCommand` after
 * adding to the map; stopped by the tick body when the map empties.
 *
 * Pre-fix the timer was per-command and `runShellCommand` would clear
 * the previous timer when a second command fired — so concurrent
 * commands raced their completion handlers. The new shape supports the
 * §57.3.4 concurrency model and the global `setShellBusy` is wired to
 * `runningButtons.size > 0` rather than a per-command boolean.
 */
function startShellPoll(): void {
  if (shellPollTimer !== null) return;
  shellPollTimer = setInterval(async () => {
    try {
      const response = await getRunningShellCommands();
      // HS-8060 — drop completed runningButtons entries + fire the
      // per-id auto-show + per-id log-badge refresh. Re-render the
      // sidebar exactly once if anything changed so the affected
      // buttons drop the spinner. Final output lands in the entry's detail
      // when the command's `close` handler writes the log entry.
      const stillRunning = new Set(response.ids);
      const completedIds: number[] = [];
      for (const [key, id] of _runningButtonsForTesting) {
        if (!stillRunning.has(id)) {
          completedIds.push(id);
          _runningButtonsForTesting.delete(key);
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
    const entries = await getCommandLog({ limit: 50 });
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

/**
 * HS-8539 — run a custom shell command in a NEW drawer terminal (the user's
 * default shell), rather than the inline streaming run. Fired by a long-press
 * on the button (always) or a normal click when the command has "Launch in New
 * Terminal" enabled. Lazy-imports `terminal.js` to avoid pulling the terminal
 * stack into the sidebar's import graph at module load.
 */
async function runShellInNewTerminal(cmd: CustomCommand): Promise<void> {
  recordCommandRun(runningKey(getActiveProject()?.secret ?? '', cmd)); // HS-8398
  try {
    void ensureSkills();
    const { openTerminalRunningCommand } = await import('./terminal.js');
    await openTerminalRunningCommand(cmd.prompt, cmd.name);
  } catch {
    showToast('Could not open a new terminal for that command.', { variant: 'warning' });
  }
}

async function runShellCommand(cmd: CustomCommand, autoShow = false): Promise<void> {
  recordCommandRun(runningKey(getActiveProject()?.secret ?? '', cmd)); // HS-8398
  setShellBusy(true);
  try {
    // Ensure AI tool skills are installed/up-to-date before running commands
    void ensureSkills();
    const result = await execShellCommand(cmd.prompt, cmd.name);
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

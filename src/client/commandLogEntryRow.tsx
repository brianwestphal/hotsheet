/**
 * Per-entry row rendering for the Commands Log drawer pane, extracted
 * out of `commandLog.tsx` per HS-8385. Owns:
 *
 * - Pure formatting helpers (relative time, direction symbol, type
 *   badge color/label, shell-detail input/output split).
 * - `cancelingShellIds` — the per-shell "user clicked Stop, awaiting
 *   confirmation" set. Owned here because both the Stop button handler
 *   and the row's render state read it; cleaned up by the polling loop
 *   via {@link cleanupCancelingShellIds}.
 * - The right-click context menu (copy current selection / this entry).
 * - `renderEntryRow` — the bindList row contract, including all four
 *   per-row reactive effects (shape, selected-class, expanded-class,
 *   partial-output write).
 *
 * Streaming-side helpers (`writePartialIntoPre`, `shouldAutoScrollToBottom`)
 * live in `commandLogStreaming.ts`; this module imports from there so the
 * partial-output effect can reuse them without re-implementing the rules.
 */

import { killShellCommand } from '../api/index.js';
import type { SafeHtml } from '../jsx-runtime.js';
import { commandLogSelectionStore } from './commandLogSelectionStore.js';
import {
  type AnnotatedEntry,
  filteredEntriesSignal,
  getEntrySignals,
} from './commandLogStore.js';
import { shouldAutoScrollToBottom, writePartialIntoPre } from './commandLogStreaming.js';
import { byIdOrNull, toElement } from './dom.js';
import { effect } from './reactive.js';
import { state } from './state.js';

/** Server-shape command-log entry. HS-8318 / §61 Phase 3b — the store's
 *  `AnnotatedEntry` wraps this with an `isRunningShell` flag baked in at
 *  reconcile time. Within this file the rendering code consumes the
 *  annotated form throughout. */
type LogEntry = AnnotatedEntry;

const cancelingShellIds = new Set<number>();

/** Lucide `copy` glyph for the context-menu "Copy" action. */
const COPY_ICON: SafeHtml = (
  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>
  </svg>
);

/** Filled square — the in-row "Stop running shell process" affordance. */
const STOP_GLYPH: SafeHtml = (
  <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none">
    <rect x="4" y="4" width="16" height="16" rx="2"/>
  </svg>
);

/** Drop ids from the `cancelingShellIds` set whose process is no longer
 *  in the server-reported running list. Called from the `loadEntries`
 *  poll tick after fetching `/shell/running`. */
export function cleanupCancelingShellIds(runningIds: readonly number[]): void {
  for (const id of cancelingShellIds) {
    if (!runningIds.includes(id)) cancelingShellIds.delete(id);
  }
}

// --- Relative time helper ---

function relativeTime(iso: string): string {
  // Parse the timestamp — ensure it's treated as UTC
  let then: number;
  if (iso.endsWith('Z') || iso.includes('+') || iso.includes('T') && iso.match(/[+-]\d{2}:\d{2}$/)) {
    then = new Date(iso).getTime();
  } else {
    // No timezone indicator — append Z to force UTC interpretation
    then = new Date(iso + 'Z').getTime();
  }
  if (isNaN(then)) return iso; // fallback to raw string if unparseable

  const diffMs = Date.now() - then;
  if (diffMs < 0) return 'just now'; // clock skew
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

// --- Direction indicator ---

function directionIndicator(dir: string): { symbol: string; color: string } {
  switch (dir) {
    case 'outgoing': return { symbol: '→', color: 'var(--accent)' };
    case 'incoming': return { symbol: '←', color: '#22c55e' };
    default: return { symbol: '●', color: 'var(--text-muted)' };
  }
}

// --- Event type badge colors ---

function typeBadgeColor(eventType: string): string {
  switch (eventType) {
    case 'trigger': return '#3b82f6';
    case 'done': return '#22c55e';
    case 'permission_request': return '#f97316';
    case 'shell_command': return '#6b7280';
    default: return '#6b7280';
  }
}

function typeBadgeLabel(eventType: string): string {
  switch (eventType) {
    case 'trigger': return 'trigger';
    case 'done': return 'done';
    case 'permission_request': return 'permission';
    case 'shell_command': return 'shell';
    default: return eventType;
  }
}

// --- Shell command detail formatting (HS-2547) ---

function formatShellDetail(detail: string): { inputLine: string; output: string } | null {
  const sep = '\n---SHELL_OUTPUT---\n';
  const idx = detail.indexOf(sep);
  if (idx === -1) return null;
  return {
    inputLine: detail.slice(0, idx),
    output: detail.slice(idx + sep.length),
  };
}

// --- Context menu (HS-2546) ---

export function dismissContextMenu() {
  document.querySelector('.command-log-context-menu')?.remove();
}

function getEntryText(entry: LogEntry): string {
  let text = entry.summary;
  if (entry.detail) text += '\n' + entry.detail;
  return text;
}

function showContextMenu(x: number, y: number, entries: LogEntry[]) {
  dismissContextMenu();
  // HS-7835 — consistent icon-row markup with the other context menus
  // (`.dropdown-icon` + `.context-menu-label` spans).
  const menu = toElement(
    <div className="command-log-context-menu" style={`left:${x}px;top:${y}px`}>
      <div className="context-menu-item" data-action="copy">
        <span className="dropdown-icon">{COPY_ICON}</span>
        <span className="context-menu-label">Copy{entries.length > 1 ? ` (${entries.length} entries)` : ''}</span>
      </div>
    </div>
  );

  const copyItem = menu.querySelector('[data-action="copy"]') as HTMLElement;
  copyItem.addEventListener('click', () => {
    const text = entries.map(e => getEntryText(e)).join('\n\n---\n\n');
    void navigator.clipboard.writeText(text);
    dismissContextMenu();
  });

  document.body.appendChild(menu);

  // Clamp to viewport
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;

  // Dismiss on outside click
  setTimeout(() => {
    const close = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        dismissContextMenu();
        document.removeEventListener('click', close, true);
      }
    };
    document.addEventListener('click', close, true);
  }, 0);
}

// --- Render entries ---

interface LogEntryRenderState {
  displayDetail: string;
  preview: string;
  hasMore: boolean;
  isRunningShell: boolean;
  isCanceling: boolean;
  shellParts: ReturnType<typeof formatShellDetail>;
}

function computeLogEntryRenderState(entry: LogEntry): LogEntryRenderState {
  const shellParts = entry.event_type === 'shell_command' ? formatShellDetail(entry.detail) : null;
  const displayDetail = shellParts ? shellParts.output : entry.detail;
  const detailLines = displayDetail.split('\n');
  const preview = detailLines.slice(0, 3).join('\n');
  const hasMore = detailLines.length > 3 || displayDetail.length > 300;
  // HS-8318 — `isRunningShell` is baked into the annotated entry at
  // store-reconcile time, not derived ad-hoc here. Pre-fix every render
  // read from a module-level `runningShellIds` Array that was rebuilt
  // wholesale on every poll tick; post-fix the per-entry signal carries
  // the flag and the row's effect re-runs only when it actually flips.
  const isRunningShell = entry.isRunningShell;
  const isCanceling = cancelingShellIds.has(entry.id);
  return { displayDetail, preview, hasMore, isRunningShell, isCanceling, shellParts };
}

function buildLogEntryEl(entry: LogEntry, s: LogEntryRenderState): HTMLElement {
  const dir = directionIndicator(entry.direction);
  const badgeColor = typeBadgeColor(entry.event_type);
  const badgeLabel = typeBadgeLabel(entry.event_type);
  const time = relativeTime(entry.created_at);
  const { shellParts, displayDetail, preview, hasMore, isRunningShell, isCanceling } = s;
  return toElement(
    <div className="command-log-entry" data-id={String(entry.id)}>
      <div className="command-log-entry-header">
        <span className="command-log-direction" style={`color:${dir.color}`}>{dir.symbol}</span>
        <span className="command-log-type-badge" style={`background:${badgeColor}`}>{badgeLabel}</span>
        <span className="command-log-summary">{entry.summary}</span>
        {isRunningShell && isCanceling
          ? <span className="command-log-canceling">{'Canceling…'}</span>
          : isRunningShell
          ? <button className="command-log-stop-btn" title="Stop process">{STOP_GLYPH}</button>
          : null}
        <span className="command-log-time">{time}</span>
      </div>
      {shellParts ? (
        <div>
          <pre className="command-log-detail command-log-shell-input">{shellParts.inputLine}</pre>
          {displayDetail !== '' ? <hr className="command-log-shell-divider" /> : null}
          {displayDetail !== '' ? <pre className="command-log-detail">{preview}{hasMore ? '…' : ''}</pre> : null}
          {hasMore ? <pre className="command-log-detail-full" style="display:none">{displayDetail}</pre> : null}
        </div>
      ) : isRunningShell ? (
        // HS-7983 — running shell entries don't carry the
        // `---SHELL_OUTPUT---` separator yet (server only writes the final
        // detail in `child.on('close')`), so `formatShellDetail` returned
        // null. HS-8015 follow-up #2 mirrors the completed-shell layout
        // above with a TWIN-pre design (preview + full) so the row is
        // click-to-expand while running:
        //
        //   - Preview pre: `.command-log-detail` (3-line clamp via the
        //     existing CSS rule). Live writer fills with the trailing
        //     `RUNNING_SHELL_PREVIEW_LINES` lines so the user sees the
        //     most recent output, not the first three lines of the
        //     buffer.
        //   - Full pre:    `.command-log-detail-full` (no clamp; gains a
        //     max-height + scroll via `.command-log-shell-partial-full`
        //     so a chatty long-running command doesn't push every other
        //     entry off-screen). Hidden until the user clicks; the
        //     existing display-swap logic in the click handler reveals
        //     it (matches the completed-shell flow).
        //
        // Both pres share `data-shell-partial-id` so the live writer +
        // hydrate find both; per-pre `data-shell-partial-mode` selects
        // tail-vs-full content. The pre is empty until the first chunk
        // arrives — `:empty { display: none }` collapses it so the
        // divider above doesn't sit on dead space.
        <div>
          <pre className="command-log-detail command-log-shell-input">{entry.detail}</pre>
          <hr className="command-log-shell-divider" />
          <pre
            className="command-log-detail command-log-shell-partial command-log-shell-partial-preview"
            data-shell-partial-id={String(entry.id)}
            data-shell-partial-mode="preview"
          ></pre>
          <pre
            className="command-log-detail-full command-log-shell-partial command-log-shell-partial-full"
            data-shell-partial-id={String(entry.id)}
            data-shell-partial-mode="full"
            style="display:none"
          ></pre>
        </div>
      ) : (
        <div>
          {entry.detail !== '' ? <pre className="command-log-detail">{preview}{hasMore ? '…' : ''}</pre> : null}
          {hasMore ? <pre className="command-log-detail-full" style="display:none">{entry.detail}</pre> : null}
        </div>
      )}
    </div>
  );
}

function bindStopButtonHandler(el: HTMLElement, entry: LogEntry): void {
  const stopBtn = el.querySelector('.command-log-stop-btn') as HTMLElement;
  stopBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    cancelingShellIds.add(entry.id);
    void killShellCommand(entry.id);
    stopBtn.replaceWith(toElement(<span className="command-log-canceling">{'Canceling…'}</span>));
  });
}

/** HS-8324 — apply the current expansion state to a row's inner
 *  display swaps. Called from the per-row expansion effect; reads
 *  `expanded` as the desired state rather than toggling a class.
 *  The pre-fix `hasMore || isRunningShell` gate (decided whether
 *  expand was meaningful at all) has moved into the click handler
 *  since the store's expanded-state is only ever set for expandable
 *  rows. */
function applyExpansionDisplay(el: HTMLElement, expanded: boolean): void {
  const detailEls = el.querySelectorAll('.command-log-detail:not(.command-log-shell-input)');
  const fullEl = el.querySelector<HTMLElement>('.command-log-detail-full');
  if (expanded) {
    for (const d of detailEls) (d as HTMLElement).style.display = 'none';
    if (fullEl) fullEl.style.display = '';
  } else {
    for (const d of detailEls) (d as HTMLElement).style.display = '';
    if (fullEl) fullEl.style.display = 'none';
  }
}

function bindEntryClickHandler(
  el: HTMLElement,
  entry: LogEntry,
  hasMore: boolean,
  isRunningShell: boolean,
): void {
  el.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if (target.closest('.command-log-stop-btn')) return;

    if (e.metaKey || e.ctrlKey) {
      commandLogSelectionStore.actions.toggleSelected(entry.id);
      return;
    }

    if (e.shiftKey) {
      const last = commandLogSelectionStore.state.value.lastClicked;
      if (last !== null) {
        // HS-8318 — read the current filtered list from the store at click
        // time so shift+click ranges target the live filter, not a stale
        // closure capture from row-mount time.
        const ids = filteredEntriesSignal.value.map(e2 => e2.id);
        const startIdx = ids.indexOf(last);
        const endIdx = ids.indexOf(entry.id);
        if (startIdx !== -1 && endIdx !== -1) {
          const [lo, hi] = startIdx < endIdx ? [startIdx, endIdx] : [endIdx, startIdx];
          commandLogSelectionStore.actions.addToSelection(ids.slice(lo, hi + 1));
          return;
        }
      }
    }

    commandLogSelectionStore.actions.selectOnly(entry.id);
    // Pre-fix `applyExpansion(el, entry, hasMore, isRunningShell)` did
    // the class-toggle + dataset update inline. With the per-row
    // expansion effect (HS-8324), the store's expanded-set is the
    // source of truth: toggle it, the effect picks it up and flips
    // the row's `.expanded` class + child `display` swaps.
    if (hasMore || isRunningShell) {
      commandLogSelectionStore.actions.toggleExpanded(entry.id);
    }
  });
}

function bindEntryContextMenu(el: HTMLElement, entry: LogEntry): void {
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // HS-8318 — read the current filtered list from the store at click
    // time instead of relying on a closure-captured snapshot. Pre-fix
    // the wholesale-rerender pattern handed every renderLogEntry call a
    // fresh `filtered` Array; post-fix bindList preserves DOM identity
    // so the row's handler closure outlives any single filter pass.
    const filtered = filteredEntriesSignal.value;
    const selected = commandLogSelectionStore.state.value.selected;
    const entriesToCopy = (selected.size > 0 && selected.has(entry.id))
      ? filtered.filter(e2 => selected.has(e2.id))
      : [entry];
    showContextMenu(e.clientX, e.clientY, entriesToCopy);
  });
}

/**
 * HS-8318 / §61 Phase 3b — per-row bindList render. Builds the wrapper
 * once for each entry id; per-row effects (a) rebuild the inner DOM
 * when the entry's `detail` / `summary` / `isRunningShell` change, and
 * (b) write partial-output chunks into the running-shell `<pre>` in
 * place. Surviving rows keep their wrapper across poll ticks, so click
 * handlers + selection + expansion state all persist.
 *
 * Returns the `bindList` row contract (`{ el, dispose }`); the disposer
 * tears down both per-row effects so a row that drops off the rolling-
 * 100 buffer doesn't keep firing against a detached wrapper.
 */
export function renderEntryRow(entry: LogEntry): { el: Element; dispose: () => void } {
  const sigs = getEntrySignals(entry.id);
  // Initial paint — every per-row effect below treats this as the
  // baseline and only rebuilds on subsequent signal changes.
  const initial = computeLogEntryRenderState(entry);
  const wrapper = buildLogEntryEl(entry, initial);
  if (initial.isRunningShell) bindStopButtonHandler(wrapper, entry);
  bindEntryClickHandler(wrapper, entry, initial.hasMore, initial.isRunningShell);
  bindEntryContextMenu(wrapper, entry);

  // Per-row "shape" effect: when the entry signal value changes
  // structurally (running → done transition, summary edit on a re-fetch),
  // replace the wrapper's inner content + re-attach the click / stop /
  // context handlers. HS-8324 — the selection + expansion classes are
  // driven by their own per-row effects below; the shape rebuild here
  // doesn't need to reapply them (the effects will refire when the
  // inner DOM changes).
  let firstShapeRun = true;
  const disposeShape = effect(() => {
    const current = sigs?.entry.value ?? entry;
    if (firstShapeRun) { firstShapeRun = false; return; }
    const s = computeLogEntryRenderState(current);
    const fresh = buildLogEntryEl(current, s);
    wrapper.replaceChildren(...Array.from(fresh.childNodes));
    if (s.isRunningShell) bindStopButtonHandler(wrapper, current);
    bindEntryClickHandler(wrapper, current, s.hasMore, s.isRunningShell);
    // contextmenu: no need to re-bind — the existing handler already
    // reads `filteredEntriesSignal.value` at click time.
    // The expansion effect below will re-fire and re-apply display
    // swaps to the fresh inner DOM because `commandLogSelectionStore`'s
    // expanded set is a stable signal (untouched by the shape change).
    applyExpansionDisplay(wrapper, commandLogSelectionStore.state.value.expanded.has(current.id));
  });

  // HS-8324 per-row `.selected` class effect. The pre-fix imperative
  // `updateSelectionClasses()` swept every row in the DOM after each
  // click; this effect flips the class only when this row's
  // membership in `selected` actually changes.
  const disposeSelected = effect(() => {
    const isSelected = commandLogSelectionStore.state.value.selected.has(entry.id);
    wrapper.classList.toggle('selected', isSelected);
  });

  // HS-8324 per-row `.expanded` class effect. Drives the `.expanded`
  // class toggle + child `display` swaps off the store. Pre-fix the
  // `applyExpansion()` call in the click handler did both inline; now
  // the click handler just calls `commandLogSelectionStore.actions.toggleExpanded(id)`
  // and this effect reacts.
  const disposeExpanded = effect(() => {
    const isExpanded = commandLogSelectionStore.state.value.expanded.has(entry.id);
    wrapper.classList.toggle('expanded', isExpanded);
    applyExpansionDisplay(wrapper, isExpanded);
  });

  // Per-row partial-output effect: subscribes to the per-entry `partial`
  // signal and writes the latest chunk into the row's
  // `<pre data-shell-partial-id>` slots. Sticky-bottom scroll lives
  // here — captures pinned-state BEFORE the textContent write so the
  // post-write `scrollHeight` doesn't fool the threshold check.
  let firstPartialRun = true;
  const disposePartial = effect(() => {
    const partial = sigs?.partial.value ?? '';
    if (firstPartialRun) { firstPartialRun = false; return; }
    if (!state.settings.shell_streaming_enabled) return;
    const partialEls = wrapper.querySelectorAll<HTMLElement>('pre.command-log-shell-partial');
    if (partialEls.length === 0) return;
    const container = byIdOrNull('command-log-entries');
    const wasPinned = container !== null
      ? shouldAutoScrollToBottom(container.scrollTop, container.clientHeight, container.scrollHeight)
      : false;
    for (const pre of partialEls) writePartialIntoPre(pre, partial);
    if (wasPinned && container !== null) container.scrollTop = container.scrollHeight;
  });

  return {
    el: wrapper,
    dispose: () => { disposeShape(); disposeSelected(); disposeExpanded(); disposePartial(); },
  };
}

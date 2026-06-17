/**
 * HS-8847 — a small styled hover tooltip for custom command buttons, replacing
 * the native `title` (which has a ~1 s delay + OS styling). Shows the command
 * name, the full command/prompt text, and its last-run time. A reused singleton
 * element positioned next to the hovered button.
 *
 * Pure content shape `CommandTooltipData` is built by the caller
 * (`commandSidebar.tsx::renderButton`) from `getCommandLastRun` + the command.
 */
import { toElement } from './dom.js';
import { formatRelativeTime } from './timeFormat.js';

export interface CommandTooltipData {
  name: string;
  command: string;
  /** ISO timestamp of the last run, or null if never run. */
  lastRunIso: string | null;
}

let tooltipEl: HTMLElement | null = null;

function ensureTooltip(): HTMLElement {
  if (tooltipEl !== null && tooltipEl.isConnected) return tooltipEl;
  const el = toElement(<div className="command-tooltip" role="tooltip" hidden={true}></div>);
  document.body.appendChild(el);
  tooltipEl = el;
  return el;
}

/** The "Last run: …" line text for the given last-run ISO (exported for tests). */
export function lastRunLine(lastRunIso: string | null): string {
  return lastRunIso !== null ? `Last run: ${formatRelativeTime(lastRunIso)}` : 'Not run yet';
}

/** Show the tooltip for `data`, anchored beside `anchor`. */
export function showCommandTooltip(anchor: HTMLElement, data: CommandTooltipData): void {
  const el = ensureTooltip();
  // Build each row separately — `toElement` requires a single root element, so a
  // multi-child fragment can't be passed directly.
  const rows: HTMLElement[] = [toElement(<div className="command-tooltip-name">{data.name}</div>)];
  if (data.command.trim() !== '') {
    rows.push(toElement(<div className="command-tooltip-cmd">{data.command}</div>));
  }
  rows.push(toElement(<div className="command-tooltip-lastrun">{lastRunLine(data.lastRunIso)}</div>));
  el.replaceChildren(...rows);
  el.hidden = false;
  positionTooltip(el, anchor);
}

export function hideCommandTooltip(): void {
  if (tooltipEl !== null) tooltipEl.hidden = true;
}

/**
 * Place the tooltip just to the RIGHT of the anchor (the command buttons live
 * in the left sidebar), vertically aligned to the anchor's top, clamped into
 * the viewport. Falls back to the left side when it would overflow the right
 * edge.
 */
function positionTooltip(el: HTMLElement, anchor: HTMLElement): void {
  const margin = 8;
  const a = anchor.getBoundingClientRect();
  const t = el.getBoundingClientRect();
  let left = a.right + margin;
  if (left + t.width > window.innerWidth - margin) {
    // Not enough room on the right — place to the left of the anchor instead.
    left = Math.max(margin, a.left - margin - t.width);
  }
  let top = a.top;
  if (top + t.height > window.innerHeight - margin) {
    top = Math.max(margin, window.innerHeight - margin - t.height);
  }
  el.style.left = `${String(Math.round(left))}px`;
  el.style.top = `${String(Math.round(top))}px`;
}

/** TEST ONLY — tear down the singleton so each test starts clean. */
export function _resetCommandTooltipForTesting(): void {
  if (tooltipEl !== null) {
    tooltipEl.remove();
    tooltipEl = null;
  }
}

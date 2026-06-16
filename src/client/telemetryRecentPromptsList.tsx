/**
 * HS-8508 — Shared recent-prompts list renderer (originally extracted
 * from the HS-8150 drawer Telemetry tab's `renderRecentPromptRow`;
 * the drawer was retired in HS-8509 and this module is now the
 * canonical home). Consumed by the analytics-dashboard telemetry
 * section (HS-8508 / §71).
 *
 * Pure: takes a `RecentPromptRow[]` and returns a `<ul>` element. A
 * delegated click handler on the list fires `openPromptDrilldown`
 * (HS-8149) for the clicked row.
 */

import type { SafeHtml } from '../jsx-runtime.js';
import { toElement } from './dom.js';
import { delegate } from './reactive.js';
import { formatCost, formatDuration, formatTokens } from './telemetryFormat.js';

export interface RecentPromptRow {
  readonly promptId: string;
  readonly ts: string;
  readonly projectSecret: string;
  readonly model: string | null;
  // HS-8779 — per-prompt enrichment (all optional/nullable; a missing field
  // renders nothing rather than a placeholder).
  readonly promptText?: string | null;
  readonly totalTokens?: number | null;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly costUsd?: number | null;
  readonly durationMs?: number | null;
  readonly toolCount?: number | null;
}

function defaultFormatTimestamp(ts: string): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

export interface RenderRecentPromptsListOpts {
  /** Format the timestamp for display. Default: locale string. */
  readonly formatTimestamp?: (ts: string) => string;
}

/**
 * HS-8779 — the headline line for a prompt row. Prefer the actual prompt-text
 * snippet (when Claude Code logs it); otherwise fall back to a labeled,
 * shortened prompt id so the row still reads as "a prompt" rather than a bare
 * uuid. The model + metrics live on the meta line below.
 */
function promptSummary(row: RecentPromptRow): string {
  const text = row.promptText?.trim();
  if (text !== undefined && text !== '') return text;
  return `Prompt ${row.promptId.slice(0, 8)}`;
}

/** HS-8779 — the muted meta line's metric chips: model + derived
 *  token/cost/duration/tool. Only chips with data are emitted (returned as JSX
 *  so they compose into the single-expression row tree), so a sparse prompt
 *  stays terse. */
function metaChips(row: RecentPromptRow): SafeHtml[] {
  const chips: SafeHtml[] = [];
  if (row.model !== null && row.model !== '') {
    chips.push(<span className="telemetry-recent-prompt-chip telemetry-recent-prompt-model">{row.model}</span>);
  }
  if (typeof row.totalTokens === 'number' && row.totalTokens > 0) {
    const io = typeof row.inputTokens === 'number' && typeof row.outputTokens === 'number'
      && (row.inputTokens > 0 || row.outputTokens > 0)
      ? `${formatTokens(row.inputTokens)} in → ${formatTokens(row.outputTokens)} out`
      : '';
    chips.push(<span className="telemetry-recent-prompt-chip" title={io}>{formatTokens(row.totalTokens)} tokens</span>);
  }
  if (typeof row.costUsd === 'number' && row.costUsd > 0) {
    chips.push(<span className="telemetry-recent-prompt-chip">{formatCost(row.costUsd)}</span>);
  }
  if (typeof row.durationMs === 'number' && row.durationMs > 0) {
    chips.push(<span className="telemetry-recent-prompt-chip">{formatDuration(row.durationMs)}</span>);
  }
  if (typeof row.toolCount === 'number' && row.toolCount > 0) {
    chips.push(<span className="telemetry-recent-prompt-chip">{`${String(row.toolCount)} ${row.toolCount === 1 ? 'tool' : 'tools'}`}</span>);
  }
  return chips;
}

export function renderRecentPromptsList(
  rows: readonly RecentPromptRow[],
  opts: RenderRecentPromptsListOpts = {},
): HTMLElement {
  const formatTimestamp = opts.formatTimestamp ?? defaultFormatTimestamp;

  const list = toElement(<ul className="telemetry-recent-prompts"></ul>);
  for (const row of rows) {
    list.appendChild(toElement(
      <li className="telemetry-recent-prompt" data-prompt-id={row.promptId} title={`Prompt ${row.promptId} — click for the full event timeline`}>
        <span className="telemetry-recent-prompt-summary">{promptSummary(row)}</span>
        <div className="telemetry-recent-prompt-meta">
          <span className="telemetry-recent-prompt-ts">{formatTimestamp(row.ts)}</span>
          {metaChips(row)}
        </div>
      </li>
    ));
  }

  // Delegated click — open the drilldown modal (HS-8149). Lazy-imports
  // the modal so a page that never opens the modal doesn't pay the
  // bundle cost. HS-8615 — kerf `delegate()` (was a hand-rolled
  // `addEventListener` + `closest()`). The root is the freshly-built `list`
  // element this function returns, so the listener dies with it when the
  // caller discards the list — the disposer is intentionally dropped via
  // `void` (no shorter-scope teardown hook, and it can't outlive its root).
  void delegate<HTMLElement>(list, 'click', '.telemetry-recent-prompt', (_e, li) => {
    const promptId = li.dataset['promptId'];
    if (typeof promptId !== 'string' || promptId === '') return;
    void import('./promptDrilldown.js').then(({ openPromptDrilldown }) => {
      openPromptDrilldown(promptId);
    });
  });

  return list;
}

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

import { toElement } from './dom.js';
import { delegate } from './reactive.js';

export interface RecentPromptRow {
  readonly promptId: string;
  readonly ts: string;
  readonly projectSecret: string;
  readonly model: string | null;
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

export function renderRecentPromptsList(
  rows: readonly RecentPromptRow[],
  opts: RenderRecentPromptsListOpts = {},
): HTMLElement {
  const formatTimestamp = opts.formatTimestamp ?? defaultFormatTimestamp;

  const list = toElement(<ul className="telemetry-recent-prompts"></ul>);
  for (const row of rows) {
    list.appendChild(toElement(
      <li className="telemetry-recent-prompt" data-prompt-id={row.promptId}>
        <span className="telemetry-recent-prompt-ts">{formatTimestamp(row.ts)}</span>
        <span className="telemetry-recent-prompt-model">{row.model ?? '(unknown model)'}</span>
        <span className="telemetry-recent-prompt-id">{row.promptId.slice(0, 12)}…</span>
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

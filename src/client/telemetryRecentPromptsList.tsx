/**
 * HS-8508 — Shared recent-prompts list renderer. Extracted out of
 * `telemetryDrawer.tsx::renderRecentPromptRow` so the new HS-8508
 * analytics-dashboard telemetry section can reuse the same render.
 *
 * Pure: takes a `RecentPromptRow[]` and returns a `<ul>` element. A
 * delegated click handler on the list fires `openPromptDrilldown`
 * (HS-8149) for the clicked row.
 *
 * Once HS-8509 retires the drawer Telemetry tab, this module is the
 * canonical home for the list render; the drawer was previously the
 * only consumer.
 */

import { toElement } from './dom.js';

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
  // bundle cost.
  list.addEventListener('click', (e) => {
    const target = e.target as Element | null;
    if (target === null) return;
    const li = target.closest<HTMLElement>('.telemetry-recent-prompt');
    if (li === null) return;
    const promptId = li.dataset['promptId'];
    if (typeof promptId !== 'string' || promptId === '') return;
    void import('./promptDrilldown.js').then(({ openPromptDrilldown }) => {
      openPromptDrilldown(promptId);
    });
  });

  return list;
}

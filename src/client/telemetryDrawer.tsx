import { api } from './api.js';
import { byIdOrNull, toElement } from './dom.js';
import { getTelemetryCostMode } from './telemetryCostMode.js';
import { renderRecentPromptsList } from './telemetryRecentPromptsList.js';
import { renderToolHistogramRow } from './telemetryToolHistogram.js';

/**
 * HS-8148 — footer drawer Telemetry tab (§67.10.2). Renders the five
 * rollup sections the design doc specifies: today / this-week / all-time
 * chips + by-model + by-tool + by-query-source + recent prompts.
 *
 * Loads via `GET /api/telemetry/drawer?scope=project|all` which returns
 * the full `DrawerPayload` in one round trip. Scope toggle lives in the
 * tab's own header (per-project default, with a button to switch to
 * cross-project view).
 *
 * Pattern matches §52 settings-store / `commandLog.tsx`-tab-content:
 * the tab content panel is server-rendered with `Loading…` placeholders,
 * the `loadAndRenderTelemetryDrawer` function is called on tab
 * activation (from `commandLog.tsx::switchDrawerTab`) and rewrites the
 * panel via `replaceChildren(toElement(<…/>))`.
 */

interface WindowTotals {
  cost: number;
  tokens: number;
  promptCount: number;
}

interface ModelRollup {
  model: string;
  cost: number;
  tokens: number;
  promptCount: number;
}

interface ToolRollup {
  tool: string;
  count: number;
  avgDurationMs: number | null;
}

interface ToolLatencyHistogram {
  tool: string;
  count: number;
  totalMs: number;
  p50: number | null;
  p90: number | null;
  p99: number | null;
  buckets: number[];
}

interface QuerySourceRollup {
  source: string;
  cost: number;
  tokens: number;
  promptCount: number;
}

interface RecentPrompt {
  promptId: string;
  ts: string;
  projectSecret: string;
  model: string | null;
}

interface DrawerPayload {
  today: WindowTotals;
  thisWeek: WindowTotals;
  allTime: WindowTotals;
  costByModel: ModelRollup[];
  toolRollup: ToolRollup[];
  toolLatencyHistogram: ToolLatencyHistogram[];
  querySourceRollup: QuerySourceRollup[];
  recentPrompts: RecentPrompt[];
}

let currentScope: 'project' | 'all' = 'project';

function formatCost(n: number): string {
  if (n === 0) return '$0.00';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(Math.round(n));
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toLocaleString();
  } catch {
    return ts;
  }
}

function renderWindowChip(label: string, totals: WindowTotals): HTMLElement {
  return toElement(
    <div className="telemetry-chip">
      <div className="telemetry-chip-label">{label}</div>
      <div className="telemetry-chip-cost">{formatCost(totals.cost)}</div>
      <div className="telemetry-chip-meta">
        {formatTokens(totals.tokens)} tokens · {String(totals.promptCount)} prompts
      </div>
    </div>
  );
}

function renderModelRow(row: ModelRollup): HTMLElement {
  return toElement(
    <tr>
      <td>{row.model}</td>
      <td className="telemetry-num">{formatCost(row.cost)}</td>
      <td className="telemetry-num">{formatTokens(row.tokens)}</td>
      <td className="telemetry-num">{String(row.promptCount)}</td>
    </tr>
  );
}

function renderToolRow(row: ToolRollup): HTMLElement {
  return toElement(
    <tr>
      <td>{row.tool}</td>
      <td className="telemetry-num">{String(row.count)}</td>
      <td className="telemetry-num">{formatDuration(row.avgDurationMs)}</td>
    </tr>
  );
}

function renderQuerySourceRow(row: QuerySourceRollup): HTMLElement {
  return toElement(
    <tr>
      <td>{row.source}</td>
      <td className="telemetry-num">{formatCost(row.cost)}</td>
      <td className="telemetry-num">{formatTokens(row.tokens)}</td>
      <td className="telemetry-num">{String(row.promptCount)}</td>
    </tr>
  );
}


function renderEmptyState(): HTMLElement {
  return toElement(
    <div className="telemetry-empty">
      <p>No telemetry data yet.</p>
      <p className="telemetry-empty-hint">
        Enable telemetry in Settings → Telemetry, then run <code>claude</code> in a Hot Sheet terminal.
        Data lands within ~60 seconds of the first export tick.
      </p>
    </div>
  );
}

/**
 * HS-8497 — subscription-mode notice banner. Rendered above the scope
 * toggle whenever the global cost mode is `'subscription'`, so a Claude
 * Pro/Max user understands that the dollar amounts shown across the
 * drawer are API-equivalent estimates rather than what they actually
 * pay (their bill is the flat subscription fee).
 */
function renderSubscriptionNotice(): HTMLElement {
  return toElement(
    <div className="telemetry-subscription-notice" role="note">
      <strong>Subscription mode:</strong> The dollar amounts below are the API-equivalent cost of your Claude Code usage. Your actual bill is your Claude Pro / Max subscription fee. Switch to <em>Pay-per-token</em> in <button type="button" className="telemetry-subscription-notice-link" data-action="open-telemetry-settings">Settings → Telemetry → Billing</button> if you're on an API key.
    </div>
  );
}

function renderScopeToggle(): HTMLElement {
  return toElement(
    <div className="telemetry-scope-toggle">
      <button
        type="button"
        className={`telemetry-scope-btn${currentScope === 'project' ? ' active' : ''}`}
        data-scope="project"
        title="Show data for the active project only"
      >
        This project
      </button>
      <button
        type="button"
        className={`telemetry-scope-btn${currentScope === 'all' ? ' active' : ''}`}
        data-scope="all"
        title="Show data across every project"
      >
        All projects
      </button>
    </div>
  );
}

function renderPayload(payload: DrawerPayload): HTMLElement {
  const hasData = payload.allTime.promptCount > 0 || payload.allTime.cost > 0;

  const subscriptionMode = getTelemetryCostMode() === 'subscription';

  if (!hasData) {
    // NOTE: render helpers return DOM elements (built via `toElement`), so
    // they cannot be composed as JSX children inside another `toElement`
    // call — the JSX runtime renders to HTML strings and throws on DOM
    // nodes. Build the empty shell with `toElement` and `appendChild` the
    // subtrees, matching the with-data branch below.
    const emptyRoot = toElement(<div className="telemetry-drawer-content"></div>);
    if (subscriptionMode) emptyRoot.appendChild(renderSubscriptionNotice());
    emptyRoot.appendChild(renderScopeToggle());
    emptyRoot.appendChild(renderEmptyState());
    return emptyRoot;
  }

  const root = toElement(<div className="telemetry-drawer-content"></div>);
  if (subscriptionMode) root.appendChild(renderSubscriptionNotice());
  root.appendChild(renderScopeToggle());

  // Window chips.
  const chips = toElement(<div className="telemetry-window-chips"></div>);
  chips.appendChild(renderWindowChip('Today', payload.today));
  chips.appendChild(renderWindowChip('This week', payload.thisWeek));
  chips.appendChild(renderWindowChip('All time', payload.allTime));
  root.appendChild(chips);

  // By model.
  if (payload.costByModel.length > 0) {
    const modelSection = toElement(
      <section className="telemetry-section">
        <h3>By model</h3>
        <table className="telemetry-table">
          <thead>
            <tr>
              <th>Model</th>
              <th className="telemetry-num">Cost</th>
              <th className="telemetry-num">Tokens</th>
              <th className="telemetry-num">Sessions</th>
            </tr>
          </thead>
          <tbody id="telemetry-tbody-model"></tbody>
        </table>
      </section>
    );
    const tbody = modelSection.querySelector('#telemetry-tbody-model');
    if (tbody !== null) {
      for (const row of payload.costByModel) tbody.appendChild(renderModelRow(row));
    }
    root.appendChild(modelSection);
  }

  // By tool.
  if (payload.toolRollup.length > 0) {
    const toolSection = toElement(
      <section className="telemetry-section">
        <h3>By tool</h3>
        <table className="telemetry-table">
          <thead>
            <tr>
              <th>Tool</th>
              <th className="telemetry-num">Count</th>
              <th className="telemetry-num">Avg duration</th>
            </tr>
          </thead>
          <tbody id="telemetry-tbody-tool"></tbody>
        </table>
      </section>
    );
    const tbody = toolSection.querySelector('#telemetry-tbody-tool');
    if (tbody !== null) {
      for (const row of payload.toolRollup) tbody.appendChild(renderToolRow(row));
    }
    root.appendChild(toolSection);
  }

  // HS-8150 — Tool latency histograms section. Render function
  // extracted to `telemetryToolHistogram.tsx` under HS-8508 so the
  // analytics-dashboard telemetry section can reuse it.
  if (payload.toolLatencyHistogram.length > 0) {
    const histSection = toElement(
      <section className="telemetry-section">
        <h3>Tool latency distribution</h3>
        <div className="telemetry-histograms" id="telemetry-histograms"></div>
      </section>
    );
    const container = histSection.querySelector('#telemetry-histograms');
    if (container !== null) {
      for (const row of payload.toolLatencyHistogram) {
        container.appendChild(renderToolHistogramRow(row, { formatDuration }));
      }
    }
    root.appendChild(histSection);
  }

  // By query source.
  if (payload.querySourceRollup.length > 0) {
    const qsSection = toElement(
      <section className="telemetry-section">
        <h3>By query source</h3>
        <table className="telemetry-table">
          <thead>
            <tr>
              <th>Source</th>
              <th className="telemetry-num">Cost</th>
              <th className="telemetry-num">Tokens</th>
              <th className="telemetry-num">Sessions</th>
            </tr>
          </thead>
          <tbody id="telemetry-tbody-source"></tbody>
        </table>
      </section>
    );
    const tbody = qsSection.querySelector('#telemetry-tbody-source');
    if (tbody !== null) {
      for (const row of payload.querySourceRollup) tbody.appendChild(renderQuerySourceRow(row));
    }
    root.appendChild(qsSection);
  }

  // Recent prompts. Render extracted to
  // `telemetryRecentPromptsList.tsx` under HS-8508. Drawer-tab click
  // routing is handled by the delegated listener inside the helper;
  // the drawer's own panel-level click listener (HS-8149) is still
  // present as a safety net but the helper's listener takes
  // precedence in normal flow.
  if (payload.recentPrompts.length > 0) {
    const promptsSection = toElement(
      <section className="telemetry-section">
        <h3>Recent prompts</h3>
      </section>
    );
    promptsSection.appendChild(renderRecentPromptsList(payload.recentPrompts, { formatTimestamp }));
    root.appendChild(promptsSection);
  }

  return root;
}

/**
 * Fetch the drawer payload + render into the `#drawer-panel-telemetry`
 * container. Called from `commandLog.tsx::switchDrawerTab` when the
 * Telemetry tab activates. Idempotent — every call replaces the
 * previous render.
 *
 * Errors render a small error block instead of throwing so a broken
 * receiver doesn't tear down the drawer chrome.
 */
export async function loadAndRenderTelemetryDrawer(): Promise<void> {
  const panel = byIdOrNull('drawer-panel-telemetry');
  if (panel === null) return;

  panel.replaceChildren(toElement(<div className="telemetry-drawer-loading">Loading telemetry…</div>));

  try {
    const payload = await api<DrawerPayload>(`/telemetry/drawer?scope=${currentScope}`);
    panel.replaceChildren(renderPayload(payload));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    panel.replaceChildren(toElement(
      <div className="telemetry-drawer-error">
        <p>Failed to load telemetry data.</p>
        <p className="telemetry-empty-hint">{message}</p>
      </div>
    ));
  }
}

/**
 * One-time wiring at app init. Installs a delegated click listener on
 * the panel for the scope-toggle buttons + the recent-prompt rows
 * (HS-8149 — clicking a row opens the per-prompt drilldown modal).
 */
export function initTelemetryDrawer(): void {
  const panel = byIdOrNull('drawer-panel-telemetry');
  if (panel === null) return;

  panel.addEventListener('click', (e) => {
    const target = e.target as HTMLElement | null;
    if (target === null) return;

    // HS-8497 — subscription-mode notice link → open Settings dialog.
    const noticeLink = target.closest<HTMLElement>('.telemetry-subscription-notice-link');
    if (noticeLink !== null) {
      const settingsBtn = byIdOrNull('settings-btn');
      if (settingsBtn !== null) (settingsBtn).click();
      return;
    }

    // Scope-toggle button → re-fetch with the new scope.
    const scopeBtn = target.closest<HTMLElement>('.telemetry-scope-btn');
    if (scopeBtn !== null) {
      const scope = scopeBtn.dataset.scope;
      if (scope === 'project' || scope === 'all') {
        if (scope !== currentScope) {
          currentScope = scope;
          void loadAndRenderTelemetryDrawer();
        }
      }
      return;
    }

    // HS-8149 — recent-prompt row → open the drilldown modal.
    const promptRow = target.closest<HTMLElement>('.telemetry-recent-prompt');
    if (promptRow !== null) {
      const promptId = promptRow.dataset.promptId;
      if (typeof promptId === 'string' && promptId !== '') {
        void import('./promptDrilldown.js').then(({ openPromptDrilldown }) => {
          openPromptDrilldown(promptId);
        });
      }
    }
  });
}

/** HS-8148 — exported for tests. NOT part of the public API. */
export const _testing = {
  formatCost,
  formatTokens,
  formatDuration,
  renderPayload,
  setScope(s: 'project' | 'all'): void { currentScope = s; },
  getScope(): 'project' | 'all' { return currentScope; },
};

import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { byIdOrNull, toElement } from './dom.js';

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

const HISTOGRAM_BUCKET_LABELS = ['<10ms', '10-50ms', '50-100ms', '100-500ms', '500ms-1s', '1-5s', '5-10s', '10s+'];

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

function renderRecentPromptRow(row: RecentPrompt): HTMLElement {
  return toElement(
    <li className="telemetry-recent-prompt" data-prompt-id={row.promptId}>
      <span className="telemetry-recent-prompt-ts">{formatTimestamp(row.ts)}</span>
      <span className="telemetry-recent-prompt-model">{row.model ?? '(unknown model)'}</span>
      <span className="telemetry-recent-prompt-id">{row.promptId.slice(0, 12)}…</span>
    </li>
  );
}

/**
 * HS-8150 — inline-SVG histogram for a single tool. No chart-library
 * dependency; just `<rect>` bars sized proportionally to the max
 * bucket count + p50/p90/p99 markers as labels below the bar row.
 * Bar fill defaults to the same accent color as the rest of the
 * Telemetry tab (`currentColor` so the SCSS theme can override).
 */
function renderHistogramRow(row: ToolLatencyHistogram): HTMLElement {
  const maxCount = Math.max(1, ...row.buckets);
  const barWidth = 30;
  const barGap = 4;
  const chartHeight = 40;
  const labelHeight = 12;
  const width = row.buckets.length * (barWidth + barGap);
  const height = chartHeight + labelHeight;

  const bars = row.buckets.map((c, i) => {
    const barHeight = c === 0 ? 0 : Math.max(2, (c / maxCount) * chartHeight);
    const x = i * (barWidth + barGap);
    const y = chartHeight - barHeight;
    return `<rect x="${String(x)}" y="${String(y)}" width="${String(barWidth)}" height="${String(barHeight)}" fill="currentColor" opacity="${c === 0 ? '0.15' : '0.7'}"><title>${HISTOGRAM_BUCKET_LABELS[i]}: ${String(c)}</title></rect>`;
  }).join('');

  return toElement(
    <div className="telemetry-histogram-row">
      <div className="telemetry-histogram-header">
        <span className="telemetry-histogram-tool">{row.tool}</span>
        <span className="telemetry-histogram-meta">
          {String(row.count)} calls · {formatDuration(row.totalMs)} total
          {row.p50 !== null ? <> · p50 <strong>{formatDuration(row.p50)}</strong></> : null}
          {row.p90 !== null ? <> · p90 <strong>{formatDuration(row.p90)}</strong></> : null}
          {row.p99 !== null ? <> · p99 <strong>{formatDuration(row.p99)}</strong></> : null}
        </span>
      </div>
      <svg className="telemetry-histogram-svg" width={String(width)} height={String(height)} viewBox={`0 0 ${String(width)} ${String(height)}`} role="img" aria-label={`${row.tool} latency histogram`}>
        {raw(bars)}
      </svg>
    </div>
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

  if (!hasData) {
    return toElement(
      <div className="telemetry-drawer-content">
        {renderScopeToggle()}
        {renderEmptyState()}
      </div>
    );
  }

  const root = toElement(<div className="telemetry-drawer-content"></div>);
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

  // HS-8150 — Tool latency histograms section.
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
        container.appendChild(renderHistogramRow(row));
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

  // Recent prompts.
  if (payload.recentPrompts.length > 0) {
    const promptsSection = toElement(
      <section className="telemetry-section">
        <h3>Recent prompts</h3>
        <ul className="telemetry-recent-prompts" id="telemetry-recent-list"></ul>
      </section>
    );
    const list = promptsSection.querySelector('#telemetry-recent-list');
    if (list !== null) {
      for (const row of payload.recentPrompts) list.appendChild(renderRecentPromptRow(row));
    }
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

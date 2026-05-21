import type { SpanRow } from '../db/otelQueries.js';
import { raw } from '../jsx-runtime.js';
import { api } from './api.js';
import { toElement } from './dom.js';
import { assembleSpanTree, findEnclosingSpanId, type SpanTreeNode } from './spanTree.js';

/**
 * HS-8149 — per-prompt timeline drilldown modal (§67.10.3). Opens an
 * overlay showing every event correlated by `prompt_id` in start-ts
 * order. Header: prompt id + first/last ts + model. Body: vertical
 * timeline; click a row to expand its `attributes_json` + `body_json`
 * verbatim for debugging.
 *
 * HS-8476 / §68.5.1: when the response carries `spans.length > 0`,
 * the body switches to a recursive span-tree render in place of the
 * flat event list. Events fold into the deepest enclosing span
 * (matched by `event.ts ∈ [span.startTs, span.endTs]` with the
 * closest `start_ts` winning on overlap).
 *
 * Overlay chrome mirrors `src/client/readerOverlay.tsx` (90vw / 90vh
 * dialog, close button + Escape + backdrop click to dismiss) but
 * renders structured timeline content instead of markdown.
 *
 * Entry point: `openPromptDrilldown(promptId)`. Called from the
 * footer-drawer Telemetry tab's recent-prompt rows (HS-8148 §67.10.2
 * — `telemetryDrawer.tsx::renderRecentPromptRow` produces the rows
 * with `data-prompt-id`).
 */

interface TimelineEntry {
  id: number;
  ts: string;
  eventName: string;
  attributesJson: Record<string, unknown>;
  bodyJson: Record<string, unknown> | null;
}

interface PromptTimeline {
  promptId: string;
  projectSecret: string | null;
  firstTs: string | null;
  lastTs: string | null;
  model: string | null;
  entries: TimelineEntry[];
  spans: SpanRow[];
  /** HS-8484 — true when the active project has the beta-traces
   *  sub-toggle on. The drilldown shows a diagnostic note when this
   *  is true AND the prompt has no spans (suggesting the prompt
   *  fired before traces were turned on). */
  tracesEnabled?: boolean;
}

function formatTs(ts: string): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

function formatTsRelative(ts: string, anchorTs: string | null): string {
  if (anchorTs === null) return '';
  try {
    const ms = new Date(ts).getTime() - new Date(anchorTs).getTime();
    if (ms < 1000) return `+${String(ms)} ms`;
    if (ms < 60_000) return `+${(ms / 1000).toFixed(2)} s`;
    return `+${(ms / 60_000).toFixed(2)} min`;
  } catch {
    return '';
  }
}

function eventBadgeClass(eventName: string): string {
  if (eventName.includes('user_prompt')) return 'telemetry-event-prompt';
  if (eventName.includes('api_request')) return 'telemetry-event-api';
  if (eventName.includes('api_error')) return 'telemetry-event-error';
  if (eventName.includes('tool_result')) return 'telemetry-event-tool';
  if (eventName.includes('tool_decision')) return 'telemetry-event-decision';
  return 'telemetry-event-other';
}

function renderTimelineRow(entry: TimelineEntry, firstTs: string | null): HTMLElement {
  const row = toElement(
    <li className={`telemetry-timeline-row ${eventBadgeClass(entry.eventName)}`}>
      <button type="button" className="telemetry-timeline-toggle" aria-expanded="false">
        <span className="telemetry-timeline-ts">{formatTs(entry.ts)}</span>
        <span className="telemetry-timeline-rel">{formatTsRelative(entry.ts, firstTs)}</span>
        <span className="telemetry-timeline-event">{entry.eventName}</span>
      </button>
      <div className="telemetry-timeline-detail" style="display:none">
        <h4>Attributes</h4>
        <pre className="telemetry-timeline-json">{JSON.stringify(entry.attributesJson, null, 2)}</pre>
        {entry.bodyJson !== null
          ? <>
              <h4>Body</h4>
              <pre className="telemetry-timeline-json">{JSON.stringify(entry.bodyJson, null, 2)}</pre>
            </>
          : null}
      </div>
    </li>
  );
  const toggle = row.querySelector<HTMLButtonElement>('.telemetry-timeline-toggle');
  const detail = row.querySelector<HTMLElement>('.telemetry-timeline-detail');
  if (toggle !== null && detail !== null) {
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      detail.style.display = expanded ? 'none' : '';
    });
  }
  return row;
}

function formatDurationMs(ms: number): string {
  if (ms < 1) return `${ms.toFixed(2)} ms`;
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60_000).toFixed(2)} min`;
}

function spanDurationMs(span: SpanRow): number {
  return new Date(span.endTs).getTime() - new Date(span.startTs).getTime();
}

function spanStatusBadgeClass(statusCode: string | null): string {
  if (statusCode === 'ERROR') return 'telemetry-span-status-error';
  if (statusCode === 'OK') return 'telemetry-span-status-ok';
  return 'telemetry-span-status-unset';
}

function spanStatusLabel(statusCode: string | null): string {
  if (statusCode === 'ERROR') return 'ERROR';
  if (statusCode === 'OK') return 'OK';
  return 'UNSET';
}

function renderSpanRow(node: SpanTreeNode, firstTs: string | null): HTMLElement {
  const durationMs = spanDurationMs(node.row);
  const indentPx = node.depth * 20;
  const model = node.row.spanName === 'claude_code.llm_request' && typeof node.row.attributesJson['model'] === 'string'
    ? (node.row.attributesJson['model'])
    : null;
  const row = toElement(
    <li className={`telemetry-span-row telemetry-span-depth-${String(node.depth)}`} data-span-id={node.row.spanId} style={`padding-left: ${String(indentPx)}px`}>
      <button type="button" className="telemetry-timeline-toggle telemetry-span-toggle" aria-expanded="false">
        <span className="telemetry-timeline-ts">{formatTs(node.row.startTs)}</span>
        <span className="telemetry-timeline-rel">{formatTsRelative(node.row.startTs, firstTs)}</span>
        <span className="telemetry-span-name">{node.row.spanName}</span>
        <span className="telemetry-span-duration">{formatDurationMs(durationMs)}</span>
        {model !== null
          ? <span className="telemetry-span-model">{model}</span>
          : null}
        <span className={`telemetry-span-status ${spanStatusBadgeClass(node.row.statusCode)}`}>{spanStatusLabel(node.row.statusCode)}</span>
      </button>
      <div className="telemetry-timeline-detail" style="display:none">
        <h4>Attributes</h4>
        <pre className="telemetry-timeline-json">{JSON.stringify(node.row.attributesJson, null, 2)}</pre>
      </div>
      <ul className="telemetry-span-children" data-span-id={node.row.spanId}></ul>
    </li>
  );
  const toggle = row.querySelector<HTMLButtonElement>('.telemetry-span-toggle');
  const detail = row.querySelector<HTMLElement>(':scope > .telemetry-timeline-detail');
  if (toggle !== null && detail !== null) {
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      detail.style.display = expanded ? 'none' : '';
    });
  }
  return row;
}

function renderEventLeaf(entry: TimelineEntry, firstTs: string | null): HTMLElement {
  const row = toElement(
    <li className={`telemetry-timeline-row telemetry-event-leaf ${eventBadgeClass(entry.eventName)}`}>
      <button type="button" className="telemetry-timeline-toggle" aria-expanded="false">
        <span className="telemetry-timeline-ts">{formatTs(entry.ts)}</span>
        <span className="telemetry-timeline-rel">{formatTsRelative(entry.ts, firstTs)}</span>
        <span className="telemetry-timeline-event">{entry.eventName}</span>
      </button>
      <div className="telemetry-timeline-detail" style="display:none">
        <h4>Attributes</h4>
        <pre className="telemetry-timeline-json">{JSON.stringify(entry.attributesJson, null, 2)}</pre>
        {entry.bodyJson !== null
          ? <>
              <h4>Body</h4>
              <pre className="telemetry-timeline-json">{JSON.stringify(entry.bodyJson, null, 2)}</pre>
            </>
          : null}
      </div>
    </li>
  );
  const toggle = row.querySelector<HTMLButtonElement>('.telemetry-timeline-toggle');
  const detail = row.querySelector<HTMLElement>(':scope > .telemetry-timeline-detail');
  if (toggle !== null && detail !== null) {
    toggle.addEventListener('click', () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      toggle.setAttribute('aria-expanded', expanded ? 'false' : 'true');
      detail.style.display = expanded ? 'none' : '';
    });
  }
  return row;
}

function appendSpanSubtree(parentList: HTMLElement, node: SpanTreeNode, firstTs: string | null, eventsBySpanId: Map<string, TimelineEntry[]>): void {
  const row = renderSpanRow(node, firstTs);
  parentList.appendChild(row);
  const childrenList = row.querySelector<HTMLElement>(`.telemetry-span-children[data-span-id="${node.row.spanId}"]`);
  if (childrenList === null) return;

  const enclosedEvents = eventsBySpanId.get(node.row.spanId) ?? [];
  for (const entry of enclosedEvents) {
    childrenList.appendChild(renderEventLeaf(entry, firstTs));
  }
  for (const child of node.children) {
    appendSpanSubtree(childrenList, child, firstTs, eventsBySpanId);
  }
}

/**
 * HS-8477 / §68.5.2 — flatten the assembled span tree to a list of
 * `(node, depth)` pairs in tree order. The waterfall renderer needs
 * a linear sequence so the y-coordinate of each bar is the index
 * within the depth dimension. Tree order (parents before children,
 * children left-to-right by start_ts) keeps the visual grouping
 * stable.
 */
function flattenSpanTree(roots: SpanTreeNode[]): SpanTreeNode[] {
  const out: SpanTreeNode[] = [];
  function walk(node: SpanTreeNode): void {
    out.push(node);
    for (const child of node.children) walk(child);
  }
  for (const root of roots) walk(root);
  return out;
}

/**
 * HS-8477 / §68.5.2 — render the collapsible waterfall panel that
 * sits above the span tree. Default-collapsed `<details>` so the
 * user opts into the visual. Body is an inline `<svg>` with one
 * `<rect>` per span positioned by `start_ts` (x) + duration
 * (width) on the time axis, and tree depth on the y axis. Click a
 * bar scrolls the corresponding span row into view with a 600 ms
 * flash highlight (`.span-tree-row-flash`).
 */
function renderWaterfallPanel(timeline: PromptTimeline): HTMLElement | null {
  if (timeline.spans.length === 0) return null;
  const tree = assembleSpanTree(timeline.spans);
  const flat = flattenSpanTree(tree);

  // Time-axis bounds: min(start) → max(end) across every span.
  let minStart = Infinity;
  let maxEnd = -Infinity;
  let maxDepth = 0;
  for (const node of flat) {
    const start = new Date(node.row.startTs).getTime();
    const end = new Date(node.row.endTs).getTime();
    if (start < minStart) minStart = start;
    if (end > maxEnd) maxEnd = end;
    if (node.depth > maxDepth) maxDepth = node.depth;
  }
  const totalMs = Math.max(maxEnd - minStart, 1);

  const width = 800; // viewBox width — scales via CSS
  const rowHeight = 24;
  const barHeight = 20;
  const vbHeight = (maxDepth + 1) * rowHeight;

  function escapeAttr(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  const barsHtml = flat.map(node => {
    const start = new Date(node.row.startTs).getTime();
    const end = new Date(node.row.endTs).getTime();
    const x = ((start - minStart) / totalMs) * width;
    const w = Math.max(((end - start) / totalMs) * width, 1);
    const y = node.depth * rowHeight + (rowHeight - barHeight) / 2;
    const durationMs = end - start;
    const model = node.row.spanName === 'claude_code.llm_request' && typeof node.row.attributesJson['model'] === 'string'
      ? ` — ${node.row.attributesJson['model']}`
      : '';
    const label = `${node.row.spanName} — ${formatDurationMs(durationMs)}${model}`;
    const statusClass = spanStatusBadgeClass(node.row.statusCode);
    return `<rect x="${String(x)}" y="${String(y)}" width="${String(w)}" height="${String(barHeight)}" class="telemetry-trace-waterfall-bar ${statusClass}" data-span-id="${escapeAttr(node.row.spanId)}"><title>${escapeAttr(label)}</title></rect>`;
  }).join('');

  const panel = toElement(
    <details className="telemetry-trace-waterfall">
      <summary className="telemetry-trace-waterfall-summary">
        <span className="telemetry-trace-waterfall-label">Trace</span>
        <span className="telemetry-trace-waterfall-beta" title="Claude Code's enhanced-tracing surface is upstream-beta and may change without notice.">BETA</span>
        <span className="telemetry-trace-waterfall-meta">{`${String(flat.length)} spans · ${formatDurationMs(totalMs)} total`}</span>
      </summary>
      <div className="telemetry-trace-waterfall-body" style={`max-height: ${String(Math.min(vbHeight, 240))}px; overflow-y: auto`}>
        <svg className="telemetry-trace-waterfall-svg" viewBox={`0 0 ${String(width)} ${String(vbHeight)}`} preserveAspectRatio="none" width="100%" height={String(vbHeight)} role="img" aria-label="Trace waterfall">
          {raw(barsHtml)}
        </svg>
      </div>
    </details>
  );

  // Delegated click on the SVG canvas → look up the bar's span id +
  // scroll the matching span row into view with a flash.
  const svg = panel.querySelector<SVGSVGElement>('.telemetry-trace-waterfall-svg');
  if (svg !== null) {
    svg.addEventListener('click', (e) => {
      const target = e.target as Element | null;
      if (target === null) return;
      const spanId = target.getAttribute('data-span-id');
      if (spanId === null) return;
      scrollToSpanRow(spanId);
    });
  }

  return panel;
}

/**
 * HS-8477 / §68.5.2 — scroll the matching span row into view +
 * flash it for 600 ms. Looks up the row via the `data-span-id`
 * attribute the span renderer attaches (in `renderSpanRow` we set
 * `<ul class="telemetry-span-children" data-span-id="X">`, but for
 * the row itself we need a parallel attribute — added in this
 * commit). The flash relies on `.span-tree-row-flash` being defined
 * in the eventual SCSS sweep; until then the class is harmless.
 */
function scrollToSpanRow(spanId: string): void {
  const row = document.querySelector<HTMLElement>(`.telemetry-span-row[data-span-id="${spanId}"]`);
  if (row === null) return;
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  row.classList.add('span-tree-row-flash');
  window.setTimeout(() => {
    row.classList.remove('span-tree-row-flash');
  }, 600);
}

function renderSpanTreeBody(timeline: PromptTimeline, firstTs: string | null): HTMLElement {
  const tree = assembleSpanTree(timeline.spans);

  // Partition events by which span (if any) encloses their ts.
  const eventsBySpanId = new Map<string, TimelineEntry[]>();
  const orphanEvents: TimelineEntry[] = [];
  for (const entry of timeline.entries) {
    const spanId = findEnclosingSpanId(entry.ts, timeline.spans);
    if (spanId === null) {
      orphanEvents.push(entry);
    } else {
      const list = eventsBySpanId.get(spanId) ?? [];
      list.push(entry);
      eventsBySpanId.set(spanId, list);
    }
  }

  const root = toElement(
    <ul className="telemetry-span-tree" id="telemetry-span-tree"></ul>
  );
  // Events that fall outside every span render at the top as leaves.
  for (const entry of orphanEvents) {
    root.appendChild(renderEventLeaf(entry, firstTs));
  }
  for (const node of tree) {
    appendSpanSubtree(root, node, firstTs, eventsBySpanId);
  }
  return root;
}

function renderTimeline(timeline: PromptTimeline): HTMLElement {
  const root = toElement(
    <div className="telemetry-drilldown-body">
      <div className="telemetry-drilldown-header-meta">
        <div className="telemetry-drilldown-meta-row">
          <span className="telemetry-drilldown-meta-label">Prompt id:</span>
          <code className="telemetry-drilldown-meta-value">{timeline.promptId}</code>
        </div>
        {timeline.firstTs !== null
          ? <div className="telemetry-drilldown-meta-row">
              <span className="telemetry-drilldown-meta-label">First event:</span>
              <span className="telemetry-drilldown-meta-value">{formatTs(timeline.firstTs)}</span>
            </div>
          : null}
        {timeline.lastTs !== null && timeline.lastTs !== timeline.firstTs
          ? <div className="telemetry-drilldown-meta-row">
              <span className="telemetry-drilldown-meta-label">Last event:</span>
              <span className="telemetry-drilldown-meta-value">{formatTs(timeline.lastTs)}</span>
            </div>
          : null}
        {timeline.model !== null
          ? <div className="telemetry-drilldown-meta-row">
              <span className="telemetry-drilldown-meta-label">Model:</span>
              <span className="telemetry-drilldown-meta-value">{timeline.model}</span>
            </div>
          : null}
        <div className="telemetry-drilldown-meta-row">
          <span className="telemetry-drilldown-meta-label">Events:</span>
          <span className="telemetry-drilldown-meta-value">{String(timeline.entries.length)}</span>
        </div>
        {timeline.spans.length > 0
          ? <div className="telemetry-drilldown-meta-row">
              <span className="telemetry-drilldown-meta-label">Spans:</span>
              <span className="telemetry-drilldown-meta-value">{String(timeline.spans.length)}</span>
            </div>
          : null}
      </div>
      <div className="telemetry-drilldown-trace-slot" id="telemetry-drilldown-trace-slot"></div>
      {/* HS-8484 — diagnostic note when traces are enabled but the
          prompt has no spans (e.g. prompt fired before traces flipped
          on). Helps the user understand why the waterfall is missing. */}
      {timeline.tracesEnabled === true && timeline.spans.length === 0 && timeline.entries.length > 0
        ? <p className="telemetry-traces-beta-note">
            <span className="telemetry-traces-beta-note-chip">BETA</span>
            No spans recorded for this prompt — traces are emitted starting after the next session-start. If your <code>claude</code> session was already running when you enabled traces, restart it to begin capturing spans.
          </p>
        : null}
      {timeline.entries.length === 0 && timeline.spans.length === 0
        ? <p className="telemetry-drilldown-empty">No events recorded for this prompt id.</p>
        : timeline.spans.length > 0
          ? <div className="telemetry-span-tree-container" id="telemetry-span-tree-container"></div>
          : <ol className="telemetry-timeline-list" id="telemetry-timeline-list"></ol>}
    </div>
  );

  if (timeline.spans.length > 0) {
    const traceSlot = root.querySelector<HTMLElement>('#telemetry-drilldown-trace-slot');
    const waterfall = renderWaterfallPanel(timeline);
    if (traceSlot !== null && waterfall !== null) {
      traceSlot.appendChild(waterfall);
    }
    const container = root.querySelector<HTMLElement>('#telemetry-span-tree-container');
    if (container !== null) {
      container.appendChild(renderSpanTreeBody(timeline, timeline.firstTs));
    }
  } else {
    const list = root.querySelector<HTMLElement>('#telemetry-timeline-list');
    if (list !== null) {
      for (const entry of timeline.entries) {
        list.appendChild(renderTimelineRow(entry, timeline.firstTs));
      }
    }
  }
  return root;
}

/**
 * Open the per-prompt drilldown overlay for a given `prompt_id`.
 * Idempotent — calling twice in a row removes the prior overlay
 * before mounting the new one.
 *
 * The fetch is async; the overlay shows a "Loading…" body initially
 * and swaps in the timeline once the response lands. Failures
 * render an inline error message rather than throwing.
 */
export function openPromptDrilldown(promptId: string): void {
  // Drop any prior overlay so re-trigger doesn't stack.
  document.querySelectorAll('.telemetry-drilldown-overlay').forEach(el => el.remove());

  const overlay = toElement(
    <div className="telemetry-drilldown-overlay reader-mode-overlay" role="dialog" aria-modal="true" aria-label={`Prompt ${promptId} timeline`}>
      <div className="telemetry-drilldown-dialog reader-mode-dialog">
        <div className="telemetry-drilldown-header reader-mode-header">
          <span className="telemetry-drilldown-title reader-mode-title">Prompt timeline</span>
          <div className="reader-mode-header-actions">
            <button className="telemetry-drilldown-close reader-mode-close" type="button" title="Close" aria-label="Close drilldown">×</button>
          </div>
        </div>
        <div className="telemetry-drilldown-content">
          <p className="telemetry-drilldown-loading">Loading timeline…</p>
        </div>
      </div>
    </div>
  );

  document.body.appendChild(overlay);

  // Dismiss handlers — Escape + close button + backdrop click.
  function dismiss(): void {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
  }
  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') {
      e.stopPropagation();
      dismiss();
    }
  }
  document.addEventListener('keydown', onKey);
  overlay.querySelector('.telemetry-drilldown-close')?.addEventListener('click', dismiss);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) dismiss();
  });

  const content = overlay.querySelector<HTMLElement>('.telemetry-drilldown-content');
  if (content === null) return;

  void (async () => {
    try {
      const timeline = await api<PromptTimeline>(`/telemetry/prompt/${encodeURIComponent(promptId)}`);
      content.replaceChildren(renderTimeline(timeline));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      content.replaceChildren(toElement(
        <div className="telemetry-drilldown-error">
          <p>Failed to load timeline.</p>
          <p className="telemetry-drilldown-error-detail">{message}</p>
        </div>
      ));
    }
  })();
}

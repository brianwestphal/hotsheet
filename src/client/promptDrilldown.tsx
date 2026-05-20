import { api } from './api.js';
import { toElement } from './dom.js';

/**
 * HS-8149 — per-prompt timeline drilldown modal (§67.10.3). Opens an
 * overlay showing every event correlated by `prompt_id` in start-ts
 * order. Header: prompt id + first/last ts + model. Body: vertical
 * timeline; click a row to expand its `attributes_json` + `body_json`
 * verbatim for debugging.
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
      </div>
      {timeline.entries.length === 0
        ? <p className="telemetry-drilldown-empty">No events recorded for this prompt id.</p>
        : <ol className="telemetry-timeline-list" id="telemetry-timeline-list"></ol>}
    </div>
  );
  const list = root.querySelector<HTMLElement>('#telemetry-timeline-list');
  if (list !== null) {
    for (const entry of timeline.entries) {
      list.appendChild(renderTimelineRow(entry, timeline.firstTs));
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

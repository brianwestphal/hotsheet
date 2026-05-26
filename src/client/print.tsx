import { printHtml } from '../api/index.js';
import { NotesArraySchema, parseJsonOrNull } from '../schemas.js';
import { parseTags } from './detail.js';
import { byIdOrNull, toElement } from './dom.js';
import type { Ticket } from './state.js';
import { getCategoryColor, getCategoryLabel, state } from './state.js';

type PrintScope = 'dashboard' | 'view' | 'selected' | 'current';
type PrintFormat = 'checklist' | 'summary' | 'full';

export function showPrintDialog() {
  const isDashboard = state.view === 'dashboard';
  const hasSelection = state.selectedIds.size > 0;
  const hasCurrent = state.activeTicketId != null;

  const overlay = toElement(
    <div className="print-dialog-overlay">
      <div className="print-dialog">
        <div className="print-dialog-header">
          <span>Print</span>
          <button className="detail-close" id="print-close">{'\u00d7'}</button>
        </div>
        <div className="print-dialog-body">
          <div className="settings-field">
            <label>What to print</label>
            <select id="print-scope">
              {isDashboard ? <option value="dashboard">Dashboard</option> : null}
              {!isDashboard ? <option value="view">All tickets in current view</option> : null}
              {!isDashboard && hasSelection ? <option value="selected">Selected tickets ({String(state.selectedIds.size)})</option> : null}
              {!isDashboard && hasCurrent ? <option value="current">Current ticket detail</option> : null}
            </select>
          </div>
          <div className="settings-field" id="print-format-field">
            <label>Format</label>
            <select id="print-format">
              <option value="checklist">Checklist (titles only)</option>
              <option value="summary">Summary (title, category, priority, status)</option>
              <option value="full">Full details</option>
            </select>
          </div>
        </div>
        <div className="print-dialog-footer">
          <button className="btn btn-sm" id="print-cancel">Cancel</button>
          <button className="btn btn-sm btn-accent" id="print-go">Print</button>
        </div>
      </div>
    </div>
  );

  const scopeSelect = overlay.querySelector('#print-scope') as HTMLSelectElement;
  const formatField = overlay.querySelector('#print-format-field') as HTMLElement;

  // Hide format choice for dashboard
  const updateFormatVisibility = () => {
    formatField.style.display = scopeSelect.value === 'dashboard' ? 'none' : '';
  };
  scopeSelect.addEventListener('change', updateFormatVisibility);
  updateFormatVisibility();

  const close = () => overlay.remove();
  overlay.querySelector('#print-close')!.addEventListener('click', close);
  overlay.querySelector('#print-cancel')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  overlay.querySelector('#print-go')!.addEventListener('click', () => {
    const scope = scopeSelect.value as PrintScope;
    const format = (overlay.querySelector('#print-format') as HTMLSelectElement).value as PrintFormat;
    close();

    if (scope === 'dashboard') {
      printDashboard();
    } else {
      const tickets = getTicketsForScope(scope);
      printTickets(tickets, format);
    }
  });

  document.body.appendChild(overlay);
}

function getTicketsForScope(scope: PrintScope): Ticket[] {
  if (scope === 'selected') {
    return state.tickets.filter(t => state.selectedIds.has(t.id));
  }
  if (scope === 'current' && state.activeTicketId != null) {
    const t = state.tickets.find(t => t.id === state.activeTicketId);
    return t ? [t] : [];
  }
  return state.tickets;
}

function printHTML(bodyHTML: string) {
  const fullHTML = `<!DOCTYPE html><html><head>
    <meta charset="utf-8">
    <title>Hot Sheet</title>
    <style>${printStyles()}</style>
  </head><body>${bodyHTML}</body></html>`;

  void printHtml(fullHTML);
}

function printDashboard() {
  const dashboard = byIdOrNull('dashboard-container');
  if (!dashboard) return;
  printHTML(`<style>${printStyles()}
    ${dashboardPrintStyles()}
  </style>${dashboard.innerHTML}`);
}

/** HS-8525 — dashboard-specific print styles. Extracted from
 *  `printDashboard` so unit tests can assert that every analytics-
 *  telemetry-* class that ships into the dashboard markup has a
 *  matching print rule. Pre-fix the Claude-usage section (rendered
 *  via `analyticsTelemetrySection.tsx`) was un-styled in print —
 *  full-width SVGs + tiny stacked labels — because the print
 *  stylesheet only knew about the ticket-charts grid classes. */
export function dashboardPrintStyles(): string {
  return `
    .dashboard-grid { grid-template-columns: 1fr 1fr; }
    .dashboard-kpi-row { grid-template-columns: repeat(4, 1fr); }
    .dashboard-chart-body svg { max-width: 100%; }
    .chart-cursor, .chart-tooltip, .dashboard-info-btn, .dashboard-range-bar, .dashboard-chart-info { display: none !important; }
    /* HS-8525 — Claude usage / analytics-telemetry section rules so
       the per-project telemetry block in the dashboard prints with
       the same boxed card aesthetic as the ticket charts above
       (KPI tiles + throughput + cycle time + category breakdown).
       Pre-fix the section dumped raw unstyled HTML with full-width
       SVGs + tiny stacked labels because the printStyles function
       didn't know about any of the analytics-telemetry-* classes. */
    .analytics-telemetry-section { margin-top: 24px; padding-top: 16px; border-top: 1px solid #ddd; display: flex; flex-direction: column; gap: 12px; }
    .analytics-telemetry-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .analytics-telemetry-title { font-size: 16px; font-weight: 600; margin: 0; }
    .analytics-telemetry-window-selector { display: none !important; }
    .analytics-telemetry-body { display: flex; flex-direction: column; gap: 12px; }
    .analytics-telemetry-section-block { border: 1px solid #ddd; border-radius: 6px; padding: 8px 12px; }
    .analytics-telemetry-section-block h3 { font-size: 11px; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 0.05em; margin: 0 0 8px 0; }
    .analytics-telemetry-chips { display: flex; gap: 8px; flex-wrap: wrap; }
    .telemetry-chip, .telemetry-dashboard-chip { flex: 1 1 0; min-width: 120px; padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px; text-align: center; }
    .telemetry-chip-label, .telemetry-dashboard-chip-label { font-size: 10px; font-weight: 600; color: #666; text-transform: uppercase; letter-spacing: 0.05em; }
    .telemetry-chip-cost, .telemetry-dashboard-chip-cost { font-size: 18px; font-weight: 700; color: #111; }
    .telemetry-chip-meta, .telemetry-dashboard-chip-meta { font-size: 10px; color: #666; }
    /* Cost-over-time + cost-by-model: constrain chart width and
       fix the donut at a printable size so it doesn't render as a
       pixel-wide ring (which is what the unstyled output produced). */
    .telemetry-cost-over-time-chart { width: 100%; }
    .telemetry-cost-over-time-svg-wrap { width: 100%; }
    .telemetry-cost-over-time-svg { width: 100%; height: auto; max-height: 220px; display: block; }
    .telemetry-cost-over-time-mode-toggle { display: none !important; }
    .telemetry-cost-over-time-legend { display: flex; flex-wrap: wrap; gap: 6px 12px; padding-top: 6px; font-size: 10px; }
    .telemetry-dashboard-model-donut-wrap { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
    .telemetry-dashboard-model-donut { width: 120px; height: 120px; flex-shrink: 0; }
    .telemetry-dashboard-model-legend { font-size: 11px; display: flex; flex-direction: column; gap: 4px; list-style: none; padding: 0; margin: 0; }
    .telemetry-dashboard-model-legend-row { display: flex; align-items: center; gap: 8px; }
    .telemetry-dashboard-model-legend-swatch { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
    .telemetry-dashboard-model-legend-name { flex: 1; }
    .telemetry-dashboard-model-legend-pct { color: #666; font-variant-numeric: tabular-nums; }
    .telemetry-dashboard-model-legend-cost { font-variant-numeric: tabular-nums; font-weight: 600; }
    .telemetry-dashboard-model-single-caption { font-size: 10px; color: #666; margin-top: 4px; }
    /* Tool latency histograms — render rows in a compact one-per-line
       block so they don't overlap with the donut above. */
    .telemetry-histogram-row { padding: 6px 0; border-bottom: 1px solid #f0f0f0; }
    .telemetry-histogram-row:last-child { border-bottom: none; }
    .telemetry-histogram-header { display: flex; justify-content: space-between; align-items: baseline; font-size: 11px; margin-bottom: 2px; }
    .telemetry-histogram-tool { font-weight: 600; }
    .telemetry-histogram-meta { color: #666; font-variant-numeric: tabular-nums; }
    .telemetry-histogram-svg { width: 100%; max-width: 320px; height: 24px; display: block; }
    /* Recent prompts list — table-like rows. */
    .telemetry-recent-prompts { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 2px; font-size: 11px; }
    .telemetry-recent-prompt { display: flex; gap: 10px; padding: 3px 0; border-bottom: 1px solid #f0f0f0; }
    .telemetry-recent-prompt:last-child { border-bottom: none; }
    .telemetry-recent-prompt-ts { color: #666; font-variant-numeric: tabular-nums; }
    .telemetry-recent-prompt-model { font-weight: 600; }
    .telemetry-recent-prompt-id { color: #888; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  `;
}

function printTickets(tickets: Ticket[], format: PrintFormat) {
  let body = '';
  if (format === 'checklist') {
    body = `<h2>Checklist</h2><div class="print-checklist">${tickets.map(t =>
      `<div class="print-check-item"><span class="print-checkbox">\u25a1</span><span>${esc(t.ticket_number)}: ${esc(t.title)}</span></div>`
    ).join('')}</div>`;
  } else if (format === 'summary') {
    body = `<h2>Ticket Summary</h2><table class="print-table">
      <thead><tr><th>Ticket</th><th>Title</th><th>Category</th><th>Priority</th><th>Status</th><th>Up Next</th></tr></thead>
      <tbody>${tickets.map(t => {
        const cat = state.categories.find(c => c.id === t.category);
        return `<tr>
          <td>${esc(t.ticket_number)}</td>
          <td>${esc(t.title)}</td>
          <td><span class="print-cat" style="background:${getCategoryColor(t.category)}">${esc(getCategoryLabel(t.category))}</span> ${esc(cat?.label ?? t.category)}</td>
          <td>${esc(t.priority)}</td>
          <td>${esc(t.status.replace(/_/g, ' '))}</td>
          <td>${t.up_next ? '\u2605' : ''}</td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
  } else {
    body = tickets.map(t => {
      const cat = state.categories.find(c => c.id === t.category);
      const tags = parseTags(t.tags);
      // HS-8567 — zod-validate the notes JSON column.
      const parsedNotes = parseJsonOrNull(NotesArraySchema, t.notes);
      const notes: { text: string; created_at: string }[] = parsedNotes ?? [];

      return `<div class="print-ticket">
        <div class="print-ticket-header">
          <span class="print-cat" style="background:${getCategoryColor(t.category)}">${esc(getCategoryLabel(t.category))}</span>
          <strong>${esc(t.ticket_number)}</strong>: ${esc(t.title)}
          ${t.up_next ? '<span class="print-star">\u2605</span>' : ''}
        </div>
        <div class="print-ticket-meta">
          ${esc(cat?.label ?? t.category)} \u00b7 ${esc(t.priority)} \u00b7 ${esc(t.status.replace(/_/g, ' '))}
          ${tags.length > 0 ? ' \u00b7 ' + tags.map(tg => `<span class="print-tag">${esc(tg)}</span>`).join(' ') : ''}
        </div>
        ${t.details.trim() ? `<div class="print-ticket-details">${esc(t.details)}</div>` : ''}
        ${notes.length > 0 ? `<div class="print-ticket-notes"><strong>Notes:</strong>${notes.map(n =>
          `<div class="print-note">${n.created_at ? `<span class="print-note-time">${new Date(n.created_at).toLocaleString()}</span>` : ''}${esc(n.text)}</div>`
        ).join('')}</div>` : ''}
      </div>`;
    }).join('');
  }

  printHTML(`<style>${printStyles()}</style>${body}`);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function printStyles(): string {
  return `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; font-size: 12px; color: #111; padding: 20px; }
    h2 { font-size: 16px; margin-bottom: 12px; }
    .print-checklist { display: flex; flex-direction: column; gap: 6px; }
    .print-check-item { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    .print-checkbox { font-size: 16px; color: #999; }
    .print-table { width: 100%; border-collapse: collapse; font-size: 12px; }
    .print-table th, .print-table td { padding: 6px 8px; border: 1px solid #ddd; text-align: left; }
    .print-table th { background: #f5f5f5; font-weight: 600; }
    .print-cat { display: inline-block; padding: 1px 5px; border-radius: 3px; font-size: 9px; font-weight: 600; color: white; text-transform: uppercase; vertical-align: middle; }
    .print-star { color: #eab308; }
    .print-tag { display: inline-block; padding: 1px 6px; background: #f0f0f0; border-radius: 10px; font-size: 10px; }
    .print-ticket { margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid #eee; }
    .print-ticket-header { font-size: 14px; margin-bottom: 4px; }
    .print-ticket-meta { font-size: 11px; color: #666; margin-bottom: 6px; }
    .print-ticket-details { white-space: pre-wrap; font-size: 12px; margin-bottom: 6px; background: #fafafa; padding: 8px; border-radius: 4px; }
    .print-ticket-notes { font-size: 11px; }
    .print-note { margin-top: 4px; padding: 4px 8px; background: #f5f5f5; border-left: 3px solid #3b82f6; border-radius: 3px; }
    .print-note-time { color: #999; font-size: 10px; display: block; margin-bottom: 2px; }
    .dashboard-kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
    .dashboard-kpi-card { padding: 12px; border: 1px solid #ddd; border-radius: 6px; text-align: center; }
    .kpi-value { font-size: 24px; font-weight: 700; }
    .kpi-label { font-size: 11px; color: #666; }
    .kpi-trend { font-size: 11px; }
    .kpi-trend.up { color: #22c55e; }
    .kpi-trend.down { color: #ef4444; }
    .dashboard-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .dashboard-chart-card { border: 1px solid #ddd; border-radius: 6px; overflow: hidden; }
    .dashboard-chart-header { padding: 8px 12px; border-bottom: 1px solid #ddd; font-size: 12px; font-weight: 600; }
    .dashboard-chart-body { padding: 8px; }
    .chart-legend { display: flex; flex-wrap: wrap; gap: 6px 12px; padding-bottom: 6px; font-size: 10px; }
    .chart-legend-item { display: inline-flex; align-items: center; gap: 4px; }
    .chart-legend-dot { width: 8px; height: 8px; border-radius: 50%; }
    @media print { body { padding: 0; } }
  `;
}

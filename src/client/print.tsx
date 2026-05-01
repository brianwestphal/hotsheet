import { api } from './api.js';
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

  void api('/print', { method: 'POST', body: { html: fullHTML } });
}

function printDashboard() {
  const dashboard = byIdOrNull('dashboard-container');
  if (!dashboard) return;
  printHTML(`<style>${printStyles()}
    .dashboard-grid { grid-template-columns: 1fr 1fr; }
    .dashboard-kpi-row { grid-template-columns: repeat(4, 1fr); }
    .dashboard-chart-body svg { max-width: 100%; }
    .chart-cursor, .chart-tooltip, .dashboard-info-btn, .dashboard-range-bar, .dashboard-chart-info { display: none !important; }
  </style>${dashboard.innerHTML}`);
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
      let notes: { text: string; created_at: string }[] = [];
      try { notes = JSON.parse(t.notes) as typeof notes; } catch { /* empty */ }
      if (!Array.isArray(notes)) notes = [];

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

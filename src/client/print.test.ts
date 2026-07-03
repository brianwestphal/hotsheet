// @vitest-environment happy-dom
// HS-9144 — branch coverage for the print dialog (scope options, format visibility,
// scope→tickets selection, and the print-go build paths).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dashboardPrintStyles, showPrintDialog } from './print.js';
import { state, type Ticket } from './state.js';

const { printHtml } = vi.hoisted(() => ({ printHtml: vi.fn((_html: string): Promise<void> => Promise.resolve()) }));
vi.mock('../api/index.js', () => ({ printHtml }));

function ticket(id: number, title: string): Ticket {
  return {
    id, ticket_number: `HS-${String(id)}`, title, category: 'bug', priority: 'default',
    status: 'not_started', details: '', notes: '[]', tags: '[]', up_next: false,
  } as unknown as Ticket;
}

beforeEach(() => {
  printHtml.mockClear();
  state.view = 'list';
  state.categories = [{ id: 'bug', label: 'Bug', color: '#c00' }] as typeof state.categories;
  state.tickets = [ticket(1, 'Alpha'), ticket(2, 'Beta'), ticket(3, 'Gamma')];
  state.selectedIds = new Set();
  state.activeTicketId = null;
  document.body.replaceChildren();
});
afterEach(() => { document.body.replaceChildren(); });

const scopeValues = () => [...document.querySelectorAll('#print-scope option')].map(o => (o as HTMLOptionElement).value);

describe('showPrintDialog — scope options', () => {
  it('offers only "dashboard" on the dashboard view (format field hidden)', () => {
    state.view = 'dashboard';
    showPrintDialog();
    expect(scopeValues()).toEqual(['dashboard']);
    expect((document.querySelector('#print-format-field') as HTMLElement).style.display).toBe('none');
  });

  it('offers "view" (+ format field visible) but not selected/current when neither applies', () => {
    showPrintDialog();
    expect(scopeValues()).toEqual(['view']);
    expect((document.querySelector('#print-format-field') as HTMLElement).style.display).toBe('');
  });

  it('adds "selected" when there is a selection', () => {
    state.selectedIds = new Set([1, 2]);
    showPrintDialog();
    expect(scopeValues()).toEqual(['view', 'selected']);
    expect(document.querySelector('#print-scope option[value="selected"]')!.textContent).toContain('(2)');
  });

  it('adds "current" when a ticket is active', () => {
    state.activeTicketId = 2;
    showPrintDialog();
    expect(scopeValues()).toEqual(['view', 'current']);
  });
});

describe('showPrintDialog — actions', () => {
  it('cancel removes the overlay', () => {
    showPrintDialog();
    expect(document.querySelector('.print-dialog-overlay')).not.toBeNull();
    (document.querySelector('#print-cancel') as HTMLElement).click();
    expect(document.querySelector('.print-dialog-overlay')).toBeNull();
  });

  it('a backdrop click (on the overlay itself) closes the dialog', () => {
    showPrintDialog();
    const overlay = document.querySelector('.print-dialog-overlay') as HTMLElement;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // e.target === overlay only when the click lands on the backdrop; simulate it
    overlay.click();
    expect(document.querySelector('.print-dialog-overlay')).toBeNull();
  });

  it('print-go with the "view" scope prints every ticket as a checklist', () => {
    showPrintDialog();
    (document.querySelector('#print-format') as HTMLSelectElement).value = 'checklist';
    (document.querySelector('#print-go') as HTMLElement).click();
    expect(printHtml).toHaveBeenCalledOnce();
    const html = printHtml.mock.calls[0][0];
    expect(html).toContain('Checklist');
    expect(html).toContain('Alpha');
    expect(html).toContain('Gamma');
  });

  it('print-go with "selected" prints only the selected tickets', () => {
    state.selectedIds = new Set([2]);
    showPrintDialog();
    (document.querySelector('#print-scope') as HTMLSelectElement).value = 'selected';
    (document.querySelector('#print-format') as HTMLSelectElement).value = 'summary';
    (document.querySelector('#print-go') as HTMLElement).click();
    const html = printHtml.mock.calls[0][0];
    expect(html).toContain('Beta');
    expect(html).not.toContain('Alpha');
  });

  it('print-go with the dashboard scope prints the dashboard container', () => {
    state.view = 'dashboard';
    const dash = document.createElement('div');
    dash.id = 'dashboard-container';
    dash.innerHTML = '<div class="dashboard-grid">charts</div>';
    document.body.appendChild(dash);
    showPrintDialog();
    (document.querySelector('#print-go') as HTMLElement).click();
    expect(printHtml).toHaveBeenCalledOnce();
    expect(printHtml.mock.calls[0][0]).toContain('charts');
  });
});

describe('dashboardPrintStyles', () => {
  it('includes the analytics-telemetry + dashboard-grid print rules (HS-8525)', () => {
    const css = dashboardPrintStyles();
    expect(css).toContain('.dashboard-grid');
    expect(css).toContain('.analytics-telemetry-section');
  });
});

// HS-8864 — "In-flight work" overlay (docs/90 §90.8). A fleet-wide glance at every
// ticket currently claimed by a worker, with its worker label + live lease
// countdown (the per-ticket sibling of the worker-pool panel). Reads the reactive
// `claimsStore`, so it updates as claims come/go (poll today; the HS-7945 bus
// later) and the countdowns tick each second. Clicking a row opens that ticket.
import { type ClaimRow } from '../api/index.js';
import { renderClaimedByChip } from './claimedByChip.js';
import { claimsListSignal, nowTick } from './claimsStore.js';
import { toElement } from './dom.js';
import { effect } from './reactive.js';

let activeOverlay: HTMLElement | null = null;
let disposeEffect: (() => void) | null = null;

export function closeInflightPanel(): void {
  if (disposeEffect !== null) { disposeEffect(); disposeEffect = null; }
  if (activeOverlay !== null) {
    activeOverlay.remove();
    activeOverlay = null;
    document.removeEventListener('keydown', onKeydown, true);
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') { e.preventDefault(); closeInflightPanel(); }
}

/** Build one in-flight row: ticket number + title + the claimed-by chip. Exported
 *  for tests. `onOpen` fires when the row is clicked. */
export function renderInflightRow(claim: ClaimRow, now: number, onOpen: (ticketId: number) => void): HTMLElement {
  const row = toElement(
    <div className="inflight-row" data-ticket-id={String(claim.ticketId)} role="button" tabIndex={0}>
      <span className="inflight-row-number">{claim.ticketNumber}</span>
      <span className="inflight-row-title" title={claim.title}>{claim.title}</span>
      <span className="inflight-row-chip"></span>
    </div>,
  );
  row.querySelector('.inflight-row-chip')?.replaceChildren(renderClaimedByChip(claim, now));
  row.addEventListener('click', () => onOpen(claim.ticketId));
  row.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(claim.ticketId); } });
  return row;
}

/** Render the current claim set into `bodyEl`. Exported for tests. */
export function renderInflightList(bodyEl: HTMLElement, claims: readonly ClaimRow[], now: number, onOpen: (ticketId: number) => void): void {
  if (claims.length === 0) {
    bodyEl.replaceChildren(toElement(<div className="inflight-empty">No tickets are currently being worked.</div>));
    return;
  }
  bodyEl.replaceChildren(...claims.map(c => renderInflightRow(c, now, onOpen)));
}

function openTicket(ticketId: number): void {
  closeInflightPanel();
  void import('./detail.js').then(m => m.selectAndOpenDetail(ticketId));
}

/** Open the in-flight overlay (singleton). */
export function openInflightPanel(): void {
  closeInflightPanel();
  const overlay = toElement(
    <div className="inflight-overlay">
      <div className="inflight-dialog" role="dialog" aria-label="In-flight work">
        <div className="inflight-header">
          <span className="inflight-title">In-flight work</span>
          <button type="button" className="inflight-close" title="Close">{'×'}</button>
        </div>
        <div className="inflight-body"></div>
      </div>
    </div>,
  );
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeInflightPanel(); });
  overlay.querySelector('.inflight-close')?.addEventListener('click', closeInflightPanel);
  document.addEventListener('keydown', onKeydown, true);

  const bodyEl = overlay.querySelector<HTMLElement>('.inflight-body')!;
  document.body.appendChild(overlay);
  activeOverlay = overlay;

  // Reactive: rebuild the list as claims change + the countdowns tick.
  disposeEffect = effect(() => {
    renderInflightList(bodyEl, claimsListSignal.value, nowTick.value, openTicket);
  });
}

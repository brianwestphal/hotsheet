// HS-8977 — editable AI-partition overlay (docs/92 §92.6). Replaces the
// read-only confirm in `workerPoolPanel.tsx::handlePartition`: shows each worker
// with its proposed tickets and lets the owner reassign a ticket to another
// worker (via a native, Tauri-safe `<select>` — drag is a noted enhancement)
// before dispatching. Reuses the `.worker-pool-*` modal shell for styling.

import { toElement } from './dom.js';
import { createPartitionEdit, type PartitionAssignment, type PartitionEdit, type PartitionInput } from './partitionEdit.js';

let activeOverlay: HTMLElement | null = null;

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closePartitionEditor();
}

export function closePartitionEditor(): void {
  if (activeOverlay !== null) {
    activeOverlay.remove();
    activeOverlay = null;
    document.removeEventListener('keydown', onKeydown, true);
  }
}

function renderBody(edit: PartitionEdit) {
  return (
    <div className="partition-cols" style="display:flex; gap:12px; flex-wrap:wrap; align-items:flex-start">
      {edit.workers.map(w => {
        const ids = edit.ticketsFor(w.worker);
        return (
          <div className="partition-worker-col" data-worker={w.worker} style="min-width:180px; flex:1">
            <div className="partition-worker-label" style="font-weight:600; margin-bottom:4px">
              {w.label} <span className="partition-count" style="opacity:0.6">({String(ids.length)})</span>
            </div>
            {ids.length === 0
              ? <div className="partition-empty" style="opacity:0.5; font-style:italic">— empty —</div>
              : (
                <ul className="partition-ticket-list" style="list-style:none; padding:0; margin:0; display:flex; flex-direction:column; gap:4px">
                  {ids.map(id => (
                    <li className="partition-ticket-row" data-ticket-id={String(id)} draggable={true} style="display:flex; gap:6px; align-items:center; justify-content:space-between; cursor:grab">
                      <span className="partition-ticket-num">{edit.ticketNumber(id)}</span>
                      <select className="partition-move-select" data-ticket-id={String(id)} title="Move to worker">
                        {edit.workers.map(ww => (
                          <option value={ww.worker} selected={ww.worker === edit.assignedWorker(id)}>{ww.label}</option>
                        ))}
                      </select>
                    </li>
                  ))}
                </ul>
              )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Open the editable-partition overlay. `onApply` receives the (possibly edited)
 * non-empty per-worker chunks when the owner clicks Apply; the editor closes
 * first so the caller's dispatch + toast run over a clean UI.
 */
export function openPartitionEditor(
  input: readonly PartitionInput[],
  onApply: (chunks: PartitionAssignment[]) => void | Promise<void>,
): void {
  closePartitionEditor();
  const edit = createPartitionEdit(input);

  const overlay = toElement(
    <div className="worker-pool-overlay">
      <div className="worker-pool-dialog" role="dialog" aria-label="Edit partition">
        <div className="worker-pool-header">
          <span className="worker-pool-title">Edit partition before dispatch</span>
          <button type="button" className="worker-pool-close" title="Close">{'×'}</button>
        </div>
        <div className="worker-pool-body partition-editor-body"></div>
        <div className="worker-pool-controls">
          <button type="button" className="btn btn-sm partition-editor-cancel">Cancel</button>
          <button type="button" className="btn btn-sm partition-editor-apply">Apply + Dispatch</button>
        </div>
      </div>
    </div>,
  );

  const body = overlay.querySelector<HTMLElement>('.partition-editor-body')!;
  const render = (): void => { body.replaceChildren(toElement(renderBody(edit))); };
  render();

  // Delegated change handler — a reassign moves the ticket + re-renders.
  body.addEventListener('change', (e) => {
    const sel = e.target;
    if (sel instanceof HTMLSelectElement && sel.dataset.ticketId !== undefined) {
      edit.move(Number(sel.dataset.ticketId), sel.value);
      render();
    }
  });

  // HS-8988 — drag a ticket row onto another worker column (the `<select>` stays
  // as the Tauri-safe fallback). Module-level `draggedId` is more robust than
  // `dataTransfer` across WKWebView / test envs; the move reuses the same tested
  // `PartitionEdit.move` model the select uses.
  let draggedId: number | null = null;
  const colOf = (t: EventTarget | null): HTMLElement | null =>
    t instanceof Element ? t.closest<HTMLElement>('.partition-worker-col') : null;

  body.addEventListener('dragstart', (e) => {
    const row = e.target instanceof Element ? e.target.closest<HTMLElement>('.partition-ticket-row') : null;
    draggedId = row?.dataset.ticketId !== undefined ? Number(row.dataset.ticketId) : null;
    if (draggedId !== null && e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  });
  body.addEventListener('dragover', (e) => {
    const col = colOf(e.target);
    if (col === null || draggedId === null) return;
    e.preventDefault(); // allow the drop
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
    if (!col.classList.contains('drag-over')) {
      body.querySelectorAll('.partition-worker-col.drag-over').forEach(el => el.classList.remove('drag-over'));
      col.classList.add('drag-over');
    }
  });
  body.addEventListener('dragleave', (e) => { colOf(e.target)?.classList.remove('drag-over'); });
  body.addEventListener('drop', (e) => {
    const col = colOf(e.target);
    if (col === null || draggedId === null) return;
    e.preventDefault();
    const worker = col.dataset.worker;
    if (worker !== undefined) edit.move(draggedId, worker);
    draggedId = null;
    render(); // re-render drops the .drag-over highlight too
  });

  overlay.addEventListener('click', (e) => { if (e.target === overlay) closePartitionEditor(); });
  overlay.querySelector('.worker-pool-close')?.addEventListener('click', closePartitionEditor);
  overlay.querySelector('.partition-editor-cancel')?.addEventListener('click', closePartitionEditor);
  overlay.querySelector('.partition-editor-apply')?.addEventListener('click', () => {
    const chunks = edit.nonEmptyAssignments();
    closePartitionEditor();
    void onApply(chunks);
  });

  document.addEventListener('keydown', onKeydown, true);
  document.body.appendChild(overlay);
  activeOverlay = overlay;
}

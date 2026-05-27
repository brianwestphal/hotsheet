import { getTags, updateTicket } from '../api/index.js';
import { displayTag, hasTag, normalizeTag, parseTags, refreshDetail } from './detail.js';
import { toElement } from './dom.js';
import { delegate } from './reactive.js';
import { state } from './state.js';
import { loadTickets } from './ticketList.js';

export async function showTagsDialog() {
  const selectedTickets = state.tickets.filter(t => state.selectedIds.has(t.id));
  if (selectedTickets.length === 0) return;

  // Get all known tags
  const allTags: string[] = await getTags();

  // Also include tags from selected tickets that might not be in allTags
  for (const t of selectedTickets) {
    for (const tag of parseTags(t.tags)) {
      if (!hasTag(allTags, tag)) allTags.push(normalizeTag(tag));
    }
  }
  allTags.sort();

  // Compute initial check state: checked (all have), unchecked (none have), mixed (some have)
  type TagState = 'checked' | 'unchecked' | 'mixed';
  const tagStates = new Map<string, TagState>();
  for (const tag of allTags) {
    const count = selectedTickets.filter(t => hasTag(parseTags(t.tags), tag)).length;
    if (count === selectedTickets.length) tagStates.set(tag, 'checked');
    else if (count === 0) tagStates.set(tag, 'unchecked');
    else tagStates.set(tag, 'mixed');
  }

  // Track user changes (only changed tags will be applied)
  const originalStates = new Map(tagStates);
  const currentStates = new Map(tagStates);

  const overlay = toElement(
    <div className="tags-dialog-overlay">
      <div className="tags-dialog">
        <div className="tags-dialog-header">
          <span>Tags</span>
          <button className="detail-close" id="tags-dialog-close">{'\u00d7'}</button>
        </div>
        <div className="tags-dialog-body" id="tags-dialog-body"></div>
        <div className="tags-dialog-new">
          <input type="text" id="tags-dialog-new-input" placeholder="New tag..." />
          <button className="btn btn-sm" id="tags-dialog-add-btn">Add</button>
        </div>
        <div className="tags-dialog-footer">
          <button className="btn btn-sm" id="tags-dialog-cancel">Cancel</button>
          <button className="btn btn-sm btn-accent" id="tags-dialog-done">Done</button>
        </div>
      </div>
    </div>
  );

  const body = overlay.querySelector<HTMLElement>('#tags-dialog-body')!;

  function renderTagRows() {
    // HS-8614 — rows are pure markup carrying `data-tag`; the checkbox
    // `change` listener is delegated once on `#tags-dialog-body` below (it
    // reads the tag off `data-tag` rather than closing over the loop variable).
    // `indeterminate` has no HTML attribute form, so it stays an imperative
    // per-checkbox property write — that's a property, not a listener, so it
    // doesn't reintroduce the re-attach-on-rebuild smell.
    const rows: Element[] = [];
    for (const tag of allTags) {
      const st = currentStates.get(tag)!;
      const row = toElement(
        <label className="tags-dialog-row" data-tag={tag}>
          <input type="checkbox" checked={st === 'checked'} />
          <span>{displayTag(tag)}</span>
        </label>
      );
      if (st === 'mixed') (row.querySelector('input') as HTMLInputElement).indeterminate = true;
      rows.push(row);
    }
    if (allTags.length === 0) {
      rows.push(toElement(<div style="padding:12px 16px;color:var(--text-muted);font-size:13px">No tags yet. Create one below.</div>));
    }
    body.replaceChildren(...rows);
  }

  // One delegated listener at the stable body container, disposed on close
  // (kerf hard rule #5 — the dialog's scope is shorter than the page).
  const disposeRowDelegate = delegate<HTMLInputElement>(body, 'change', '.tags-dialog-row input[type="checkbox"]', (_e, cb) => {
    const tag = cb.closest<HTMLElement>('.tags-dialog-row')?.dataset.tag;
    if (tag === undefined) return;
    currentStates.set(tag, cb.checked ? 'checked' : 'unchecked');
  });

  renderTagRows();
  document.body.appendChild(overlay);

  // Add new tag
  const newInput = overlay.querySelector('#tags-dialog-new-input') as HTMLInputElement;
  const doneBtn = overlay.querySelector('#tags-dialog-done') as HTMLButtonElement;

  function updateDoneState() {
    const hasText = newInput.value.trim() !== '';
    doneBtn.disabled = hasText;
    doneBtn.title = hasText ? 'Add or clear the tag text first' : '';
  }

  const addTag = () => {
    const val = normalizeTag(newInput.value);
    if (!val || hasTag(allTags, val)) { newInput.value = ''; updateDoneState(); return; }
    allTags.push(val);
    allTags.sort();
    currentStates.set(val, 'checked');
    originalStates.set(val, 'unchecked');
    newInput.value = '';
    updateDoneState();
    renderTagRows();
  };
  overlay.querySelector('#tags-dialog-add-btn')!.addEventListener('click', addTag);
  newInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addTag(); } });
  newInput.addEventListener('input', updateDoneState);

  // Close/cancel
  const close = () => { disposeRowDelegate(); overlay.remove(); };
  overlay.querySelector('#tags-dialog-close')!.addEventListener('click', close);
  overlay.querySelector('#tags-dialog-cancel')!.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  // Done — apply changes
  overlay.querySelector('#tags-dialog-done')!.addEventListener('click', async () => {
    // Find tags whose state changed from original
    const toAdd: string[] = [];
    const toRemove: string[] = [];
    for (const tag of allTags) {
      const orig = originalStates.get(tag);
      const curr = currentStates.get(tag);
      if (orig === curr) continue; // no change (including mixed→mixed)
      if (curr === 'checked') toAdd.push(tag);
      else if (curr === 'unchecked') toRemove.push(tag);
    }

    if (toAdd.length > 0 || toRemove.length > 0) {
      for (const ticket of selectedTickets) {
        const current = parseTags(ticket.tags);
        let updated = [...current];
        for (const tag of toAdd) { if (!hasTag(updated, tag)) updated.push(tag); }
        for (const tag of toRemove) { updated = updated.filter(t => normalizeTag(t) !== normalizeTag(tag)); }
        if (JSON.stringify(updated) !== JSON.stringify(current)) {
          await updateTicket(ticket.id, { tags: JSON.stringify(updated) });
        }
      }
      void loadTickets();
      refreshDetail();
    }

    close();
  });
}

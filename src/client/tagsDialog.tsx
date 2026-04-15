import { api } from './api.js';
import { displayTag, hasTag, normalizeTag, parseTags, refreshDetail } from './detail.js';
import { toElement } from './dom.js';
import { state } from './state.js';
import { loadTickets } from './ticketList.js';

export async function showTagsDialog() {
  const selectedTickets = state.tickets.filter(t => state.selectedIds.has(t.id));
  if (selectedTickets.length === 0) return;

  // Get all known tags
  const allTags: string[] = await api('/tags');

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

  function renderTagRows() {
    const body = overlay.querySelector('#tags-dialog-body')!;
    body.innerHTML = '';
    for (const tag of allTags) {
      const st = currentStates.get(tag)!;
      const row = toElement(
        <label className="tags-dialog-row">
          <input type="checkbox" checked={st === 'checked'} />
          <span>{displayTag(tag)}</span>
        </label>
      );
      const cb = row.querySelector('input') as HTMLInputElement;
      if (st === 'mixed') cb.indeterminate = true;
      cb.addEventListener('change', () => {
        currentStates.set(tag, cb.checked ? 'checked' : 'unchecked');
      });
      body.appendChild(row);
    }
    if (allTags.length === 0) {
      body.appendChild(toElement(<div style="padding:12px 16px;color:var(--text-muted);font-size:13px">No tags yet. Create one below.</div>));
    }
  }

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
  const close = () => overlay.remove();
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
          await api(`/tickets/${ticket.id}`, { method: 'PATCH', body: { tags: JSON.stringify(updated) } });
        }
      }
      void loadTickets();
      refreshDetail();
    }

    close();
  });
}

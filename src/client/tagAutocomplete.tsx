/**
 * Tag autocomplete for the detail panel tag input.
 * Extracted from app.tsx for maintainability.
 */
import { api } from './api.js';
import { displayTag,hasTag, normalizeTag, parseTags, renderDetailTags } from './detail.js';
import { byId, toElement } from './dom.js';
import { allKnownTags, refreshAllKnownTags, state } from './state.js';

export function bindDetailTagInput(): void {
  const tagInput = byId<HTMLInputElement>('detail-tag-input');
  let acDropdown: HTMLElement | null = null;
  let acIndex = -1;

  void refreshAllKnownTags();

  function closeAutocomplete() {
    acDropdown?.remove();
    acDropdown = null;
    acIndex = -1;
  }

  function showAutocomplete() {
    closeAutocomplete();
    const query = tagInput.value.trim().toLowerCase();
    const ticket = state.tickets.find(t => t.id === state.activeTicketId);
    const currentTags = ticket ? parseTags(ticket.tags) : [];
    const matches = query
      ? allKnownTags.filter(t => t.toLowerCase().includes(query) && !hasTag(currentTags, t))
      : allKnownTags.filter(t => !hasTag(currentTags, t)).slice(0, 100);
    if (matches.length === 0) return;

    acDropdown = toElement(<div className="tag-autocomplete"></div>);
    for (let i = 0; i < matches.length; i++) {
      const item = toElement(<div className="tag-autocomplete-item">{displayTag(matches[i])}</div>);
      item.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        tagInput.value = matches[i];
        closeAutocomplete();
        void addCurrentTag();
      });
      acDropdown.appendChild(item);
    }

    const rect = tagInput.getBoundingClientRect();
    acDropdown.style.position = 'fixed';
    acDropdown.style.left = `${rect.left}px`;
    acDropdown.style.top = `${rect.bottom + 2}px`;
    acDropdown.style.width = `${rect.width}px`;
    document.body.appendChild(acDropdown);
  }

  async function addCurrentTag() {
    const normalized = normalizeTag(tagInput.value);
    if (normalized === '' || state.activeTicketId == null) return;
    const ticket = state.tickets.find(t => t.id === state.activeTicketId);
    if (!ticket) return;
    const currentTags = parseTags(ticket.tags);
    if (hasTag(currentTags, normalized)) { tagInput.value = ''; return; }
    const updated = [...currentTags, normalized];
    tagInput.value = '';
    closeAutocomplete();
    await api(`/tickets/${state.activeTicketId}`, { method: 'PATCH', body: { tags: JSON.stringify(updated) } });
    ticket.tags = JSON.stringify(updated);
    renderDetailTags(updated, false);
    if (!hasTag(allKnownTags, normalized)) allKnownTags.push(normalized);
  }

  tagInput.addEventListener('input', () => { showAutocomplete(); });
  tagInput.addEventListener('focus', () => { showAutocomplete(); });
  tagInput.addEventListener('blur', () => { closeAutocomplete(); });
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (acDropdown && acIndex >= 0) {
        const items = acDropdown.querySelectorAll('.tag-autocomplete-item');
        tagInput.value = items[acIndex].textContent;
      }
      closeAutocomplete();
      void addCurrentTag();
    } else if (e.key === 'Escape') {
      closeAutocomplete();
    } else if (e.key === 'ArrowDown' && acDropdown) {
      e.preventDefault();
      const items = acDropdown.querySelectorAll('.tag-autocomplete-item');
      acIndex = Math.min(acIndex + 1, items.length - 1);
      items.forEach((el, i) => el.classList.toggle('active', i === acIndex));
    } else if (e.key === 'ArrowUp' && acDropdown) {
      e.preventDefault();
      const items = acDropdown.querySelectorAll('.tag-autocomplete-item');
      acIndex = Math.max(acIndex - 1, 0);
      items.forEach((el, i) => el.classList.toggle('active', i === acIndex));
    }
  });
}

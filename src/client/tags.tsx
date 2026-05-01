import { api } from './api.js';
import { byIdOrNull, toElement } from './dom.js';
import { state } from './state.js';

/** Normalize a tag: collapse non-alphanumeric runs to single space, lowercase, trim. */
export function normalizeTag(input: string): string {
  return input.replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();
}

/** Display a tag in Title Case. */
export function displayTag(tag: string): string {
  return tag.replace(/\b\w/g, c => c.toUpperCase());
}

/** Check if a tag already exists in a list (case-insensitive, normalized). */
export function hasTag(tags: string[], tag: string): boolean {
  const norm = normalizeTag(tag);
  return tags.some(t => normalizeTag(t) === norm);
}

/** Extract bracket tags from a title, returning cleaned title and tag list.
 *  e.g. " [admin ] this is a ticket [dashboard] " returns \{ title: "this is a ticket", tags: ["admin", "dashboard"] \} */
export function extractBracketTags(input: string): { title: string; tags: string[] } {
  const tags: string[] = [];
  // Extract all [tag] patterns
  const cleaned = input.replace(/\[([^\]]*)\]/g, (_match, content: string) => {
    const tag = normalizeTag(content);
    if (tag && !tags.some(t => t === tag)) tags.push(tag);
    return ' '; // replace bracket with space
  });
  // Clean up extra whitespace
  const title = cleaned.replace(/\s+/g, ' ').trim();
  return { title, tags };
}

export function parseTags(raw: string): string[] {
  if (raw === '' || raw === '[]') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return (parsed as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim() !== '');
  } catch { /* ignore */ }
  return [];
}

export function renderDetailTags(tags: string[], readOnly: boolean) {
  const container = byIdOrNull('detail-tags');
  if (!container) return;
  container.innerHTML = '';
  for (const tag of tags) {
    const chip = toElement(
      <span className="tag-chip">
        {displayTag(tag)}
        {readOnly ? null : <button className="tag-chip-remove" data-tag={tag} title="Remove tag">{'\u00d7'}</button>}
      </span>
    );
    if (!readOnly) {
      chip.querySelector('.tag-chip-remove')!.addEventListener('click', async () => {
        if (state.activeTicketId == null) return;
        const ticket = state.tickets.find(t => t.id === state.activeTicketId);
        if (!ticket) return;
        const currentTags = parseTags(ticket.tags);
        const updated = currentTags.filter(t => t !== tag);
        await api(`/tickets/${state.activeTicketId}`, { method: 'PATCH', body: { tags: JSON.stringify(updated) } });
        ticket.tags = JSON.stringify(updated);
        renderDetailTags(updated, false);
      });
    }
    container.appendChild(chip);
  }
}

/**
 * HS-9596 (prereq for docs/6 auto-context on the API surfaces, HS-9593) — the
 * auto-context MATCH rule and its LOAD half, extracted from `sync/markdown.ts`.
 *
 * Auto-context is per-category / per-tag standing guidance that gets prepended
 * to a ticket's details in `worklist.md` and `open-tickets.md`. Until now the
 * rule that decides which entries apply to a ticket lived inline inside
 * `formatTicket`, so no other surface could carry it — which is the whole of
 * HS-9593: an agent that reaches a ticket through `hotsheet_claim_next` or
 * `hotsheet_get_ticket` sees strictly less standing guidance than the same
 * ticket in the worklist file.
 *
 * The rule has three subtleties that are easy to get wrong a second time, which
 * is why this is one shared function rather than a second implementation:
 *
 *  1. the tag match is **case-insensitive**, but the category match is not;
 *  2. matched tag entries are ordered **alphabetically by key**, after the
 *     category entry — not in settings order;
 *  3. an **empty-text** entry is a suppression, not an empty paragraph (HS-9247:
 *     an explicit empty-text override exists to cancel a built-in default).
 *
 * The merge half (user entries layered over the built-in defaults) already lives
 * in `autoContextDefaults.ts`; this module is the match half plus the I/O that
 * feeds it.
 */
import { resolveAutoContextWithDefaults } from './autoContextDefaults.js';
import { getSettings } from './db/settings.js';
import { readLocalSettings } from './file-settings.js';
import type { AutoContextEntry } from './schemas.js';
import { AutoContextArraySchema, parseJsonOrNull, TagsArraySchema } from './schemas.js';
import { isArrayDelta } from './settingsDelta.js';

/** One auto-context block that applies to a ticket, with its provenance.
 *
 *  Structured rather than one pre-joined string so a consumer keeps the "where
 *  did this come from" information — the markdown builder throws it away, but an
 *  API response should not decide that for its callers. */
export interface TicketAutoContext {
  source: 'category' | 'tag';
  /** The category id or tag name the entry is keyed on. */
  key: string;
  text: string;
}

/** The ticket fields the match rule needs. Deliberately structural, so this can
 *  be called with a DB row, a wire shape, or a test literal. */
export interface AutoContextTicketLike {
  category: string;
  /** The raw `tags` column — a JSON array string. Parsed here. */
  tags?: unknown;
}

/**
 * Which auto-context blocks apply to a ticket, in the order the worklist renders
 * them. **Pure** — no I/O, no DB, no settings access.
 *
 * Callers wanting the markdown builder's exact rendering do
 * `.map(p => p.text).join('\n\n')`.
 */
export function resolveTicketAutoContext(
  ticket: AutoContextTicketLike,
  entries: readonly AutoContextEntry[],
): TicketAutoContext[] {
  const rawTags = typeof ticket.tags === 'string' ? ticket.tags : '';
  const ticketTags: string[] = parseJsonOrNull(TagsArraySchema, rawTags) ?? [];
  const out: TicketAutoContext[] = [];

  // Category first — at most one, matched exactly.
  const category = entries.find(ac => ac.type === 'category' && ac.key === ticket.category);
  if (category !== undefined && category.text.trim() !== '') {
    out.push({ source: 'category', key: category.key, text: category.text });
  }

  // Then every matching tag, alphabetically by key. The match is
  // case-insensitive; the ORDER is by the entry's key, not the ticket's tag.
  const tagEntries = entries
    .filter(ac => ac.type === 'tag' && ticketTags.some(t => t.toLowerCase() === ac.key.toLowerCase()))
    .sort((a, b) => a.key.localeCompare(b.key));
  for (const entry of tagEntries) {
    if (entry.text.trim() === '') continue;
    out.push({ source: 'tag', key: entry.key, text: entry.text });
  }

  return out;
}

/**
 * The project's effective auto-context entries: the user's saved list layered
 * over the built-in defaults, with locally-hidden shared entries suppressed.
 *
 * Takes `dataDir` explicitly rather than reaching for the ambient one, so a
 * request handler can resolve for the project it is serving.
 */
export async function loadAutoContext(dataDir: string): Promise<AutoContextEntry[]> {
  const settings = await getSettings();
  const userEntries = parseJsonOrNull(AutoContextArraySchema, settings.auto_context) ?? [];
  // HS-9247 — layer the user's saved entries over the built-in defaults so a
  // fresh project gets useful per-category guidance; a user entry (incl. an
  // explicit empty-text one) overrides the default for that category/tag.
  // HS-9256 — but a category whose SHARED entry was locally hidden must NOT fall
  // back to the default (that would defeat the local disable).
  return resolveAutoContextWithDefaults(userEntries, localHiddenAutoContextIds(dataDir));
}

/**
 * HS-9256 — the `type:key` ids the LOCAL settings layer hides for `auto_context`
 * (a shared entry deleted on this machine). `getSettings()` returns the RESOLVED
 * array with those already removed, so the built-in default would re-inject them
 * unless we suppress it here. Reads the raw local delta's `hidden` list. Best-
 * effort — any read/shape problem yields an empty set (defaults apply normally).
 */
function localHiddenAutoContextIds(dataDir: string): ReadonlySet<string> {
  try {
    const localAc: unknown = readLocalSettings(dataDir).auto_context;
    if (isArrayDelta(localAc) && Array.isArray(localAc.hidden)) {
      // Any non-string junk in a malformed file simply never matches a default's id.
      return new Set(localAc.hidden);
    }
  } catch { /* best-effort — fall through to no suppression */ }
  return new Set();
}

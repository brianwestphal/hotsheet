/**
 * HS-8511 — per-view ticket counts for the sidebar badges. Returns a map of
 * `viewId → count` covering every sidebar entry: the built-in views ('all',
 * 'non-verified', 'up-next', 'open', 'completed', 'verified'), the special
 * lifecycle views ('backlog', 'archive', 'trash'), every `category:<id>` and
 * `priority:<level>` view, and every `custom:<id>` view.
 *
 * Built-in counts come from a handful of cheap GROUP BY queries (derived purely
 * by `deriveBuiltinViewCounts`). Custom views are counted by running each one's
 * conditions through the SAME `queryTickets` path the client uses to render it,
 * so the badge can never disagree with the list. View ids match the
 * `data-view` attributes in `src/routes/pages.tsx` / `customViews.tsx`.
 */
import { CustomViewArraySchema, parseJsonOrNull } from '../schemas.js';
import { getDb } from './connection.js';
import { getSettings } from './settings.js';
import { queryTickets } from './tickets.js';

/** Active scope = everything a default list shows: not backlog/archive/deleted. */
const ACTIVE_SCOPE = `status NOT IN ('deleted', 'backlog', 'archive')`;

export interface RawCountInputs {
  /** `status → count` across ALL tickets (every status, including deleted/backlog/archive). */
  byStatus: Record<string, number>;
  /** Up-Next count within the active scope. */
  upNext: number;
  /** `category → count` within the active scope. */
  byCategory: Record<string, number>;
  /** `priority → count` within the active scope. */
  byPriority: Record<string, number>;
}

/**
 * Pure: map raw grouped counts → the built-in sidebar view→count map. Mirrors
 * the client's `applyViewFilter` buckets (`ticketsStore.ts`). Active-scope views
 * exclude backlog/archive/deleted; the lifecycle views ('backlog'/'archive'/
 * 'trash') count exactly their status. Exported for unit testing.
 */
export function deriveBuiltinViewCounts(input: RawCountInputs): Record<string, number> {
  const s = input.byStatus;
  const g = (k: string): number => s[k] ?? 0;
  const out: Record<string, number> = {
    all: g('not_started') + g('started') + g('completed') + g('verified'),
    'non-verified': g('not_started') + g('started') + g('completed'),
    'up-next': input.upNext,
    open: g('not_started') + g('started'),
    completed: g('completed'),
    verified: g('verified'),
    backlog: g('backlog'),
    archive: g('archive'),
    trash: g('deleted'),
  };
  for (const [cat, n] of Object.entries(input.byCategory)) out[`category:${cat}`] = n;
  for (const [pri, n] of Object.entries(input.byPriority)) out[`priority:${pri}`] = n;
  return out;
}

function countMap<T>(rows: readonly T[], keyOf: (row: T) => string, countOf: (row: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const row of rows) out[keyOf(row)] = parseInt(countOf(row), 10);
  return out;
}

/** Compute the full `viewId → count` map for the active project's DB context. */
export async function getSidebarCounts(): Promise<Record<string, number>> {
  const db = await getDb();
  const [byStatusRes, upNextRes, byCatRes, byPriRes] = await Promise.all([
    db.query<{ status: string; count: string }>(`SELECT status, COUNT(*) AS count FROM tickets GROUP BY status`),
    db.query<{ count: string }>(`SELECT COUNT(*) AS count FROM tickets WHERE up_next = true AND ${ACTIVE_SCOPE}`),
    db.query<{ category: string; count: string }>(`SELECT category, COUNT(*) AS count FROM tickets WHERE ${ACTIVE_SCOPE} GROUP BY category`),
    db.query<{ priority: string; count: string }>(`SELECT priority, COUNT(*) AS count FROM tickets WHERE ${ACTIVE_SCOPE} GROUP BY priority`),
  ]);

  const counts = deriveBuiltinViewCounts({
    byStatus: countMap(byStatusRes.rows, r => r.status, r => r.count),
    upNext: parseInt(upNextRes.rows[0].count, 10),
    byCategory: countMap(byCatRes.rows, r => r.category, r => r.count),
    byPriority: countMap(byPriRes.rows, r => r.priority, r => r.count),
  });

  // Custom views — count each through the authoritative server query, so the
  // badge matches the list the user sees on click. A malformed/failing view is
  // skipped rather than failing the whole map.
  const customViews = parseJsonOrNull(CustomViewArraySchema, (await getSettings())['custom_views']);
  if (customViews !== null) {
    for (const v of customViews) {
      try {
        const rows = await queryTickets(v.logic, v.conditions, undefined, undefined, v.tag, v.includeArchived);
        counts[`custom:${v.id}`] = rows.length;
      } catch {
        /* skip a broken custom view rather than break every badge */
      }
    }
  }
  return counts;
}

import type { Ticket, TicketCategory, TicketFilters, TicketPriority, TicketStatus } from '../types.js';
import { getDb } from './connection.js';
import { generateNoteId, parseNotes } from './notes.js';

/** Escape SQL ILIKE wildcard characters so they match literally. */
function escapeIlike(value: string): string {
  return value.replace(/[%_\\]/g, '\\$&');
}

// --- Ticket number ---

export async function nextTicketNumber(prefix = 'HS'): Promise<string> {
  const db = await getDb();
  const result = await db.query<{ nextval: string }>("SELECT nextval('ticket_seq')");
  return `${prefix}-${result.rows[0].nextval}`;
}

/**
 * HS-8036 — return every distinct prefix that's appeared in `ticket_number`
 * across the project's tickets. Used by the client-side ticket-reference
 * link detector so old prefixes (e.g. a project that was once `BUG-` and
 * is now `HS-`) still resolve when their ticket numbers appear in notes.
 *
 * The regex `^([A-Z][A-Z0-9_]*)-\d+$` requires the prefix to start with
 * a letter and contain only letters / digits / underscores — typical
 * project prefix shape. Tickets with non-standard numbers (legacy
 * imports etc.) are silently skipped.
 */
export async function listKnownTicketPrefixes(): Promise<string[]> {
  const db = await getDb();
  const result = await db.query<{ ticket_number: string }>('SELECT DISTINCT ticket_number FROM tickets');
  const prefixes = new Set<string>();
  const re = /^([A-Z][A-Z0-9_]*)-\d+$/;
  for (const row of result.rows) {
    const match = re.exec(row.ticket_number);
    if (match !== null) prefixes.add(match[1]);
  }
  return [...prefixes].sort();
}

// --- Ticket CRUD ---

export async function createTicket(title: string, defaults?: Partial<{
  category: TicketCategory;
  priority: TicketPriority | '';
  status: TicketStatus | '';
  up_next: boolean;
  details: string;
  tags: string;
}>, prefix?: string): Promise<Ticket> {
  const db = await getDb();
  const ticketNumber = await nextTicketNumber(prefix);
  const cols = ['ticket_number', 'title'];
  const vals: unknown[] = [ticketNumber, title];
  if (defaults?.category !== undefined && defaults.category !== '') { cols.push('category'); vals.push(defaults.category); }
  if (defaults?.priority !== undefined && defaults.priority !== '') { cols.push('priority'); vals.push(defaults.priority); }
  if (defaults?.status !== undefined && defaults.status !== '') { cols.push('status'); vals.push(defaults.status); }
  if (defaults?.up_next !== undefined) { cols.push('up_next'); vals.push(defaults.up_next); }
  if (defaults?.details !== undefined && defaults.details !== '') { cols.push('details'); vals.push(defaults.details); }
  if (defaults?.tags !== undefined && defaults.tags !== '' && defaults.tags !== '[]') { cols.push('tags'); vals.push(defaults.tags); }

  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  const result = await db.query<Ticket>(
    `INSERT INTO tickets (${cols.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    vals
  );
  return result.rows[0];
}

export async function getTicket(id: number): Promise<Ticket | null> {
  const db = await getDb();
  const result = await db.query<Ticket>(`SELECT * FROM tickets WHERE id = $1`, [id]);
  return result.rows[0] ?? null;
}

export async function updateTicket(id: number, updates: Partial<{
  title: string;
  details: string;
  notes: string;
  tags: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  up_next: boolean;
  last_read_at: string | null;
}>, options?: { keepRead?: boolean }): Promise<Ticket | null> {
  const db = await getDb();
  // Don't bump updated_at when only last_read_at is being changed (read tracking shouldn't make tickets "unread")
  const onlyReadTracking = Object.keys(updates).length === 1 && updates.last_read_at !== undefined;
  const sets: string[] = onlyReadTracking ? [] : ['updated_at = NOW()'];
  if (!onlyReadTracking && updates.last_read_at === undefined) {
    if (options?.keepRead === true) {
      // User-initiated change: bump last_read_at so currently-read tickets stay read.
      // Don't bump for tickets that are currently unread (updated_at > last_read_at).
      sets.push('last_read_at = CASE WHEN last_read_at IS NOT NULL AND last_read_at >= updated_at THEN NOW() ELSE last_read_at END');
    } else {
      // API/AI change: ensure last_read_at is set (to epoch) so the ticket shows as unread.
      // If last_read_at is already set, leave it unchanged — updated_at bumping is enough.
      sets.push("last_read_at = COALESCE(last_read_at, '1970-01-01T00:00:00Z')");
    }
  }
  const values: unknown[] = [];
  let paramIdx = 1;

  // Columns the status-transition block below sets unconditionally. If status
  // is being updated, skip these in the general loop to avoid "multiple
  // assignments to same column" SQL errors. HS-7279 — `up_next` is ONLY
  // managed by transitions that explicitly override it (completed / verified
  // / backlog / archive all clear up_next); for not_started / started /
  // deleted the caller-supplied `up_next` must pass through the general loop
  // so that reopening a completed ticket via {status:'not_started',
  // up_next:true} (the "click star on a done ticket" client path in
  // toggleUpNext) actually flips the flag. Previously the star click left
  // the status changed but up_next stuck at false.
  const statusChanging = updates.status !== undefined;
  const statusOverridesUpNext = updates.status === 'completed'
    || updates.status === 'verified'
    || updates.status === 'backlog'
    || updates.status === 'archive';
  const STATUS_MANAGED = statusOverridesUpNext
    ? new Set(['completed_at', 'verified_at', 'deleted_at', 'up_next'])
    : new Set(['completed_at', 'verified_at', 'deleted_at']);

  const ALLOWED_COLUMNS = new Set(['title', 'details', 'tags', 'category', 'priority', 'status', 'up_next', 'notes', 'completed_at', 'verified_at', 'deleted_at', 'last_read_at']);
  for (const [key, value] of Object.entries(updates) as [string, unknown][]) {
    if (value === undefined) continue;
    if (!ALLOWED_COLUMNS.has(key)) continue;
    if (key === 'notes') continue; // handled separately below
    if (statusChanging && STATUS_MANAGED.has(key)) continue; // handled by status-transition block
    sets.push(`${key} = $${paramIdx}`);
    values.push(value);
    paramIdx++;
  }

  // Notes: append as a timestamped entry to the JSON array stored as text
  if (updates.notes !== undefined && updates.notes !== '') {
    const current = await db.query<{ notes: string }>(`SELECT notes FROM tickets WHERE id = $1`, [id]);
    const existing = parseNotes(current.rows[0]?.notes || '');
    existing.push({ id: generateNoteId(), text: updates.notes, created_at: new Date().toISOString() });
    sets.push(`notes = $${paramIdx}`);
    values.push(JSON.stringify(existing));
    paramIdx++;
  }

  // Handle status transitions
  if (updates.status === 'completed') {
    sets.push('completed_at = NOW()');
    sets.push('verified_at = NULL');
    sets.push('up_next = FALSE');
  } else if (updates.status === 'verified') {
    sets.push('verified_at = NOW()');
    // If not already completed, also set completed_at
    sets.push('completed_at = COALESCE(completed_at, NOW())');
    sets.push('up_next = FALSE');
  } else if (updates.status === 'deleted') {
    sets.push('deleted_at = NOW()');
  } else if (updates.status === 'backlog' || updates.status === 'archive') {
    sets.push('up_next = FALSE');
    sets.push('deleted_at = NULL');
  } else if (updates.status === 'not_started' || updates.status === 'started') {
    sets.push('completed_at = NULL');
    sets.push('verified_at = NULL');
    sets.push('deleted_at = NULL');
  }

  values.push(id);
  const result = await db.query<Ticket>(
    `UPDATE tickets SET ${sets.join(', ')} WHERE id = $${paramIdx} RETURNING *`,
    values
  );
  return result.rows[0] ?? null;
}

export async function deleteTicket(id: number): Promise<void> {
  await updateTicket(id, { status: 'deleted' as TicketStatus });
}

export async function hardDeleteTicket(id: number): Promise<void> {
  const db = await getDb();
  await db.query(`DELETE FROM tickets WHERE id = $1`, [id]);
}

// --- Ticket queries ---

function buildTicketWhereClause(filters: TicketFilters): { where: string; values: unknown[] } {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  // By default, exclude deleted/backlog/archive tickets from main views.
  // HS-7756 — when `include_backlog` / `include_archive` are set on top of
  // the normal status filter, the WHERE clause OR-s in those statuses so
  // search matches from the backlog / archive buckets show up alongside
  // the active set.
  const extraStatusInclusions: string[] = [];
  if (filters.include_backlog === true) extraStatusInclusions.push('backlog');
  if (filters.include_archive === true) extraStatusInclusions.push('archive');
  const wrapWithExtras = (statusCondition: string): string => {
    if (extraStatusInclusions.length === 0) return statusCondition;
    const extras = extraStatusInclusions.map(s => `'${s}'`).join(', ');
    return `(${statusCondition} OR status IN (${extras}))`;
  };

  if (filters.status === 'open') {
    conditions.push(wrapWithExtras(`status IN ('not_started', 'started')`));
  } else if (filters.status === 'non_verified') {
    conditions.push(wrapWithExtras(`status IN ('not_started', 'started', 'completed')`));
  } else if (filters.status === 'active') {
    // "All Tickets" — excludes deleted, backlog, archive
    conditions.push(wrapWithExtras(`status NOT IN ('deleted', 'backlog', 'archive')`));
  } else if (filters.status) {
    // Specific status filter (e.g. `status=backlog` itself) — extras are
    // ignored because picking a specific status is already an explicit
    // request for that bucket only.
    conditions.push(`status = $${paramIdx}`);
    values.push(filters.status);
    paramIdx++;
  } else {
    // Default: exclude deleted, backlog, archive (same as 'active')
    conditions.push(wrapWithExtras(`status NOT IN ('deleted', 'backlog', 'archive')`));
  }

  if (filters.category !== undefined && filters.category !== '') {
    conditions.push(`category = $${paramIdx}`);
    values.push(filters.category);
    paramIdx++;
  }

  if (filters.priority) {
    conditions.push(`priority = $${paramIdx}`);
    values.push(filters.priority);
    paramIdx++;
  }

  if (filters.up_next !== undefined) {
    conditions.push(`up_next = $${paramIdx}`);
    values.push(filters.up_next);
    paramIdx++;
  }

  if (filters.search !== undefined && filters.search !== '') {
    // HS-7364 — also search the notes (comments) column. Notes are stored as
    // a JSON-serialized array of `{id, text, created_at}`, so ILIKE on the
    // column matches text content inline. Substrings that collide with JSON
    // structural keys (`text`, `id`, `created_at`) or ISO timestamps will
    // over-match, but typical searches are content words that map cleanly.
    conditions.push(`(title ILIKE $${paramIdx} OR details ILIKE $${paramIdx} OR ticket_number ILIKE $${paramIdx} OR tags ILIKE $${paramIdx} OR notes ILIKE $${paramIdx})`);
    values.push(`%${escapeIlike(filters.search)}%`);
    paramIdx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return { where, values };
}

export async function getTickets(filters: TicketFilters = {}): Promise<Ticket[]> {
  const db = await getDb();
  const { where, values } = buildTicketWhereClause(filters);

  let orderBy: string;
  switch (filters.sort_by) {
    case 'priority':
      orderBy = PRIORITY_ORD;
      break;
    case 'category':
      orderBy = 'category';
      break;
    case 'status':
      orderBy = STATUS_ORD;
      break;
    case 'modified':
      orderBy = 'updated_at';
      break;
    case 'created':
    case undefined:
      orderBy = 'created_at';
      break;
  }

  const dir = filters.sort_dir === 'asc' ? 'ASC' : 'DESC';

  const result = await db.query<Ticket>(
    `SELECT * FROM tickets ${where} ORDER BY ${orderBy} ${dir}, id DESC`,
    values
  );
  return result.rows;
}

/**
 * HS-7756 — return per-status match counts for a search query, scoped to
 * the buckets (`backlog` + `archive`) that the main "active" view hides.
 * The client uses these counts to render the "Include {N} backlog items"
 * + "Include {N} archive items" rows under the multi-select toolbar.
 *
 * Search semantics match `getTickets`'s WHERE clause exactly so the
 * counts and the on-toggle-include results stay in sync.
 */
export async function countSearchMatchesInExcludedStatuses(
  search: string,
): Promise<{ backlog: number; archive: number }> {
  if (search === '') return { backlog: 0, archive: 0 };
  const db = await getDb();
  const like = `%${escapeIlike(search)}%`;
  // Run both counts in parallel — independent queries, server doesn't care.
  const [backlogRes, archiveRes] = await Promise.all([
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tickets
       WHERE status = 'backlog'
         AND (title ILIKE $1 OR details ILIKE $1 OR ticket_number ILIKE $1 OR tags ILIKE $1 OR notes ILIKE $1)`,
      [like],
    ),
    db.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM tickets
       WHERE status = 'archive'
         AND (title ILIKE $1 OR details ILIKE $1 OR ticket_number ILIKE $1 OR tags ILIKE $1 OR notes ILIKE $1)`,
      [like],
    ),
  ]);
  const backlog = Number.parseInt(backlogRes.rows[0]?.count ?? '0', 10) || 0;
  const archive = Number.parseInt(archiveRes.rows[0]?.count ?? '0', 10) || 0;
  return { backlog, archive };
}

// --- Duplicate ---

export async function duplicateTickets(ids: number[]): Promise<Ticket[]> {
  const db = await getDb();
  // Get all non-deleted titles for conflict detection
  const allTitles = await db.query<{ title: string }>(`SELECT title FROM tickets WHERE status != 'deleted'`);
  const existingTitles = new Set(allTitles.rows.map(r => r.title));
  const created: Ticket[] = [];

  for (const id of ids) {
    const ticket = await getTicket(id);
    if (!ticket) continue;

    const baseTitle = ticket.title;
    let copyTitle = `${baseTitle} - Copy`;
    if (existingTitles.has(copyTitle)) {
      let n = 2;
      while (existingTitles.has(`${baseTitle} - Copy ${n}`)) n++;
      copyTitle = `${baseTitle} - Copy ${n}`;
    }
    existingTitles.add(copyTitle);

    const newTicket = await createTicket(copyTitle, {
      category: ticket.category,
      priority: ticket.priority,
      details: ticket.details,
      up_next: ticket.up_next,
    });
    created.push(newTicket);
  }

  return created;
}

// --- Batch operations ---

export async function batchUpdateTickets(
  ids: number[],
  updates: Partial<{ category: TicketCategory; priority: TicketPriority; status: TicketStatus; up_next: boolean; last_read_at: string | null }>,
  options?: { keepRead?: boolean },
): Promise<void> {
  for (const id of ids) {
    await updateTicket(id, updates, options);
  }
}

export async function batchDeleteTickets(ids: number[]): Promise<void> {
  for (const id of ids) {
    await deleteTicket(id);
  }
}

// --- Up Next ---

export async function toggleUpNext(id: number): Promise<Ticket | null> {
  const db = await getDb();
  const result = await db.query<Ticket>(
    `UPDATE tickets SET up_next = NOT up_next, updated_at = NOW(),
      status = CASE WHEN NOT up_next AND status IN ('completed', 'verified') THEN 'not_started' ELSE status END,
      completed_at = CASE WHEN NOT up_next AND status IN ('completed', 'verified') THEN NULL ELSE completed_at END,
      verified_at = CASE WHEN NOT up_next AND status IN ('completed', 'verified') THEN NULL ELSE verified_at END
    WHERE id = $1 RETURNING *`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function getUpNextTickets(): Promise<Ticket[]> {
  return getTickets({ up_next: true, sort_by: 'priority', sort_dir: 'asc' });
}

// --- Cleanup ---

export async function getTicketsForCleanup(verifiedDays = 30, trashDays = 3): Promise<Ticket[]> {
  const db = await getDb();
  const result = await db.query<Ticket>(`
    SELECT * FROM tickets
    WHERE (status = 'verified' AND verified_at < NOW() - INTERVAL '1 day' * $1)
       OR (status = 'deleted' AND deleted_at < NOW() - INTERVAL '1 day' * $2)
  `, [verifiedDays, trashDays]);
  return result.rows;
}

// --- Custom View Query ---

const QUERYABLE_FIELDS = new Set(['category', 'priority', 'status', 'title', 'details', 'up_next', 'tags']);

const PRIORITY_ORD = `CASE priority WHEN 'highest' THEN 1 WHEN 'high' THEN 2 WHEN 'default' THEN 3 WHEN 'low' THEN 4 WHEN 'lowest' THEN 5 ELSE 3 END`;
const STATUS_ORD = `CASE status WHEN 'backlog' THEN 1 WHEN 'not_started' THEN 2 WHEN 'started' THEN 3 WHEN 'completed' THEN 4 WHEN 'verified' THEN 5 WHEN 'archive' THEN 6 ELSE 2 END`;

const PRIORITY_RANK: Record<string, number> = { highest: 1, high: 2, default: 3, low: 4, lowest: 5 };
const STATUS_RANK: Record<string, number> = { backlog: 1, not_started: 2, started: 3, completed: 4, verified: 5, archive: 6 };

function ordinalExpr(field: string): string | null {
  if (field === 'priority') return PRIORITY_ORD;
  if (field === 'status') return STATUS_ORD;
  return null;
}

function ordinalValue(field: string, value: string): number | null {
  if (field === 'priority') return PRIORITY_RANK[value] ?? null;
  if (field === 'status') return STATUS_RANK[value] ?? null;
  return null;
}

export async function queryTickets(
  logic: 'all' | 'any',
  conditions: { field: string; operator: string; value: string }[],
  sortBy?: string,
  sortDir?: string,
  requiredTag?: string,
  includeArchived?: boolean,
): Promise<Ticket[]> {
  const db = await getDb();
  const systemWhere: string[] = [];
  const userWhere: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  // Always exclude deleted
  systemWhere.push(`status != 'deleted'`);

  // Exclude archived unless explicitly included
  if (includeArchived !== true) {
    systemWhere.push(`status != 'archive'`);
  }

  for (const cond of conditions) {
    if (!QUERYABLE_FIELDS.has(cond.field)) continue;
    const field = cond.field;

    if (field === 'up_next') {
      userWhere.push(`up_next = $${paramIdx}`);
      values.push(cond.value === 'true');
      paramIdx++;
      continue;
    }

    // Handle ordinal comparisons for priority and status
    const ordExpr = ordinalExpr(field);
    const ordVal = ordExpr !== null ? ordinalValue(field, cond.value) : null;
    if (ordExpr !== null && ordVal !== null && ['lt', 'lte', 'gt', 'gte'].includes(cond.operator)) {
      const op = cond.operator === 'lt' ? '<' : cond.operator === 'lte' ? '<=' : cond.operator === 'gt' ? '>' : '>=';
      userWhere.push(`(${ordExpr}) ${op} $${paramIdx}`);
      values.push(ordVal);
      paramIdx++;
      continue;
    }

    switch (cond.operator) {
      case 'equals':
        userWhere.push(`${field} = $${paramIdx}`);
        values.push(cond.value);
        paramIdx++;
        break;
      case 'not_equals':
        userWhere.push(`${field} != $${paramIdx}`);
        values.push(cond.value);
        paramIdx++;
        break;
      case 'contains':
        userWhere.push(`${field} ILIKE $${paramIdx}`);
        values.push(`%${escapeIlike(cond.value)}%`);
        paramIdx++;
        break;
      case 'not_contains':
        userWhere.push(`${field} NOT ILIKE $${paramIdx}`);
        values.push(`%${escapeIlike(cond.value)}%`);
        paramIdx++;
        break;
    }
  }

  // Required tag filter — always AND'd regardless of logic
  if (requiredTag !== undefined && requiredTag !== '') {
    systemWhere.push(`tags ILIKE $${paramIdx}`);
    values.push(`%${requiredTag}%`);
    paramIdx++;
  }

  const joiner = logic === 'any' ? ' OR ' : ' AND ';
  // System conditions are always AND'd; user conditions are grouped by the chosen logic
  let whereClause = systemWhere.join(' AND ');
  if (userWhere.length > 0) {
    whereClause += ` AND (${userWhere.join(joiner)})`;
  }

  let orderBy: string;
  switch (sortBy) {
    case 'priority':
      orderBy = PRIORITY_ORD;
      break;
    case 'category': orderBy = 'category'; break;
    case 'status':
      orderBy = STATUS_ORD;
      break;
    case 'modified': orderBy = 'updated_at'; break;
    case undefined: orderBy = 'created_at'; break;
    default: orderBy = 'created_at'; break;
  }
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';

  const result = await db.query<Ticket>(
    `SELECT * FROM tickets WHERE ${whereClause} ORDER BY ${orderBy} ${dir}, id DESC`,
    values,
  );
  return result.rows;
}

// --- Trash ---

export async function restoreTicket(id: number): Promise<Ticket | null> {
  return updateTicket(id, { status: 'not_started' as TicketStatus });
}

export async function batchRestoreTickets(ids: number[]): Promise<void> {
  for (const id of ids) {
    await restoreTicket(id);
  }
}

export async function emptyTrash(): Promise<number[]> {
  const db = await getDb();
  const result = await db.query<{ id: number }>(`SELECT id FROM tickets WHERE status = 'deleted'`);
  const ids = result.rows.map(r => r.id);
  for (const id of ids) {
    await hardDeleteTicket(id);
  }
  return ids;
}

// --- Stats ---

export async function getTicketStats(): Promise<{
  total: number;
  open: number;
  up_next: number;
  by_category: Record<string, number>;
  by_status: Record<string, number>;
}> {
  const db = await getDb();

  const totalResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM tickets WHERE status NOT IN ('deleted', 'backlog', 'archive')`
  );
  const openResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM tickets WHERE status IN ('not_started', 'started')`
  );
  const upNextResult = await db.query<{ count: string }>(
    `SELECT COUNT(*) as count FROM tickets WHERE up_next = true AND status NOT IN ('deleted', 'backlog', 'archive')`
  );
  const byCategoryResult = await db.query<{ category: string; count: string }>(
    `SELECT category, COUNT(*) as count FROM tickets WHERE status NOT IN ('deleted', 'backlog', 'archive') GROUP BY category`
  );
  const byStatusResult = await db.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*) as count FROM tickets WHERE status != 'deleted' GROUP BY status`
  );

  const by_category: Record<string, number> = {};
  for (const row of byCategoryResult.rows) {
    by_category[row.category] = parseInt(row.count, 10);
  }

  const by_status: Record<string, number> = {};
  for (const row of byStatusResult.rows) {
    by_status[row.status] = parseInt(row.count, 10);
  }

  return {
    total: parseInt(totalResult.rows[0].count, 10),
    open: parseInt(openResult.rows[0].count, 10),
    up_next: parseInt(upNextResult.rows[0].count, 10),
    by_category,
    by_status,
  };
}

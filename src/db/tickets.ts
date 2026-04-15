import type { Ticket, TicketCategory, TicketFilters, TicketPriority, TicketStatus } from '../types.js';
import { getDb } from './connection.js';
import { generateNoteId, parseNotes } from './notes.js';

// --- Ticket number ---

export async function nextTicketNumber(prefix = 'HS'): Promise<string> {
  const db = await getDb();
  const result = await db.query<{ nextval: string }>("SELECT nextval('ticket_seq')");
  return `${prefix}-${result.rows[0].nextval}`;
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
  // When keepRead is true (user-initiated change), bump last_read_at so tickets that are
  // currently read stay read. Don't bump for tickets that are currently unread (updated_at > last_read_at).
  if (options?.keepRead === true && !onlyReadTracking && updates.last_read_at === undefined) {
    sets.push('last_read_at = CASE WHEN last_read_at IS NOT NULL AND last_read_at >= updated_at THEN NOW() ELSE last_read_at END');
  }
  const values: unknown[] = [];
  let paramIdx = 1;

  // Columns that the status-transition block below may set unconditionally.
  // If status is being updated, skip these in the general loop to avoid
  // "multiple assignments to same column" SQL errors.
  const STATUS_MANAGED = new Set(['completed_at', 'verified_at', 'deleted_at', 'up_next']);
  const statusChanging = updates.status !== undefined;

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

  // By default, exclude deleted/backlog/archive tickets from main views
  if (filters.status === 'open') {
    conditions.push(`status IN ('not_started', 'started')`);
  } else if (filters.status === 'non_verified') {
    conditions.push(`status IN ('not_started', 'started', 'completed')`);
  } else if (filters.status === 'active') {
    // "All Tickets" — excludes deleted, backlog, archive
    conditions.push(`status NOT IN ('deleted', 'backlog', 'archive')`);
  } else if (filters.status) {
    conditions.push(`status = $${paramIdx}`);
    values.push(filters.status);
    paramIdx++;
  } else {
    // Default: exclude deleted, backlog, archive (same as 'active')
    conditions.push(`status NOT IN ('deleted', 'backlog', 'archive')`);
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
    conditions.push(`(title ILIKE $${paramIdx} OR details ILIKE $${paramIdx} OR ticket_number ILIKE $${paramIdx} OR tags ILIKE $${paramIdx})`);
    values.push(`%${filters.search}%`);
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
        values.push(`%${cond.value}%`);
        paramIdx++;
        break;
      case 'not_contains':
        userWhere.push(`${field} NOT ILIKE $${paramIdx}`);
        values.push(`%${cond.value}%`);
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

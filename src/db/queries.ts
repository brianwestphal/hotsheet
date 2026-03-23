import type { Attachment, CategoryDef, Ticket, TicketCategory, TicketFilters, TicketPriority, TicketStatus } from '../types.js';
import { DEFAULT_CATEGORIES } from '../types.js';
import { getDb } from './connection.js';

// --- Notes parsing ---

interface NoteEntry { id: string; text: string; created_at: string }

let noteCounter = 0;
function generateNoteId(): string {
  return `n_${Date.now().toString(36)}_${(noteCounter++).toString(36)}`;
}

export function parseNotes(raw: string): NoteEntry[] {
  if (!raw || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      // Auto-assign IDs to legacy notes that don't have one
      return parsed.map((n: { id?: string; text: string; created_at: string }) => ({
        id: n.id || generateNoteId(),
        text: n.text,
        created_at: n.created_at,
      }));
    }
  } catch { /* not JSON yet */ }
  // Legacy: plain text notes — wrap as a single entry
  return [{ id: generateNoteId(), text: raw, created_at: new Date().toISOString() }];
}

export async function editNote(ticketId: number, noteId: string, text: string): Promise<NoteEntry[] | null> {
  const db = await getDb();
  const result = await db.query<{ notes: string }>(`SELECT notes FROM tickets WHERE id = $1`, [ticketId]);
  if (result.rows.length === 0) return null;
  const notes = parseNotes(result.rows[0].notes);
  const note = notes.find(n => n.id === noteId);
  if (!note) return null;
  note.text = text;
  await db.query(`UPDATE tickets SET notes = $1, updated_at = NOW() WHERE id = $2`, [JSON.stringify(notes), ticketId]);
  return notes;
}

export async function deleteNote(ticketId: number, noteId: string): Promise<NoteEntry[] | null> {
  const db = await getDb();
  const result = await db.query<{ notes: string }>(`SELECT notes FROM tickets WHERE id = $1`, [ticketId]);
  if (result.rows.length === 0) return null;
  const notes = parseNotes(result.rows[0].notes);
  const idx = notes.findIndex(n => n.id === noteId);
  if (idx === -1) return null;
  notes.splice(idx, 1);
  await db.query(`UPDATE tickets SET notes = $1, updated_at = NOW() WHERE id = $2`, [JSON.stringify(notes), ticketId]);
  return notes;
}

// --- Ticket number ---

export async function nextTicketNumber(): Promise<string> {
  const db = await getDb();
  const result = await db.query<{ nextval: string }>("SELECT nextval('ticket_seq')");
  return `HS-${result.rows[0].nextval}`;
}

// --- Ticket CRUD ---

export async function createTicket(title: string, defaults?: Partial<{
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  up_next: boolean;
  details: string;
}>): Promise<Ticket> {
  const db = await getDb();
  const ticketNumber = await nextTicketNumber();
  const cols = ['ticket_number', 'title'];
  const vals: unknown[] = [ticketNumber, title];
  if (defaults?.category !== undefined && defaults.category !== '') { cols.push('category'); vals.push(defaults.category); }
  if (defaults?.priority !== undefined && defaults.priority !== '') { cols.push('priority'); vals.push(defaults.priority); }
  if (defaults?.status !== undefined && defaults.status !== '') { cols.push('status'); vals.push(defaults.status); }
  if (defaults?.up_next !== undefined) { cols.push('up_next'); vals.push(defaults.up_next); }
  if (defaults?.details !== undefined && defaults.details !== '') { cols.push('details'); vals.push(defaults.details); }

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
}>): Promise<Ticket | null> {
  const db = await getDb();
  const sets: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [];
  let paramIdx = 1;

  for (const [key, value] of Object.entries(updates) as [string, unknown][]) {
    if (value === undefined) continue;
    if (key === 'notes') continue; // handled separately below
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
    sets.push('completed_at = NULL');
    sets.push('verified_at = NULL');
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

export async function getTickets(filters: TicketFilters = {}): Promise<Ticket[]> {
  const db = await getDb();
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

  if (filters.category) {
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
    conditions.push(`(title ILIKE $${paramIdx} OR details ILIKE $${paramIdx} OR ticket_number ILIKE $${paramIdx})`);
    values.push(`%${filters.search}%`);
    paramIdx++;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  let orderBy: string;
  switch (filters.sort_by) {
    case 'priority':
      // Use CASE for custom priority ordering
      orderBy = `CASE priority
        WHEN 'highest' THEN 1 WHEN 'high' THEN 2 WHEN 'default' THEN 3
        WHEN 'low' THEN 4 WHEN 'lowest' THEN 5 END`;
      break;
    case 'category':
      orderBy = 'category';
      break;
    case 'status':
      orderBy = `CASE status
        WHEN 'backlog' THEN 1 WHEN 'not_started' THEN 2 WHEN 'started' THEN 3
        WHEN 'completed' THEN 4 WHEN 'verified' THEN 5 WHEN 'archive' THEN 6 END`;
      break;
    case 'ticket_number':
      orderBy = 'id';
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
      category: ticket.category as TicketCategory,
      priority: ticket.priority as TicketPriority,
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
  updates: Partial<{ category: TicketCategory; priority: TicketPriority; status: TicketStatus; up_next: boolean }>
): Promise<void> {
  for (const id of ids) {
    await updateTicket(id, updates);
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
    `UPDATE tickets SET up_next = NOT up_next, updated_at = NOW() WHERE id = $1 RETURNING *`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function getUpNextTickets(): Promise<Ticket[]> {
  return getTickets({ up_next: true, sort_by: 'priority', sort_dir: 'asc' });
}

// --- Attachments ---

export async function addAttachment(ticketId: number, originalFilename: string, storedPath: string): Promise<Attachment> {
  const db = await getDb();
  const result = await db.query<Attachment>(
    `INSERT INTO attachments (ticket_id, original_filename, stored_path) VALUES ($1, $2, $3) RETURNING *`,
    [ticketId, originalFilename, storedPath]
  );
  return result.rows[0];
}

export async function getAttachments(ticketId: number): Promise<Attachment[]> {
  const db = await getDb();
  const result = await db.query<Attachment>(
    `SELECT * FROM attachments WHERE ticket_id = $1 ORDER BY created_at ASC`,
    [ticketId]
  );
  return result.rows;
}

export async function getAttachment(id: number): Promise<Attachment | null> {
  const db = await getDb();
  const result = await db.query<Attachment>(
    `SELECT * FROM attachments WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

export async function deleteAttachment(id: number): Promise<Attachment | null> {
  const db = await getDb();
  const result = await db.query<Attachment>(
    `DELETE FROM attachments WHERE id = $1 RETURNING *`,
    [id]
  );
  return result.rows[0] ?? null;
}

// --- Cleanup: remove attachments for old completed/deleted tickets ---

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
): Promise<Ticket[]> {
  const db = await getDb();
  const where: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  // Always exclude deleted
  where.push(`status != 'deleted'`);

  for (const cond of conditions) {
    if (!QUERYABLE_FIELDS.has(cond.field)) continue;
    const field = cond.field;

    if (field === 'up_next') {
      where.push(`up_next = $${paramIdx}`);
      values.push(cond.value === 'true');
      paramIdx++;
      continue;
    }

    // Handle ordinal comparisons for priority and status
    const ordExpr = ordinalExpr(field);
    const ordVal = ordExpr ? ordinalValue(field, cond.value) : null;
    if (ordExpr && ordVal !== null && ['lt', 'lte', 'gt', 'gte'].includes(cond.operator)) {
      const op = cond.operator === 'lt' ? '<' : cond.operator === 'lte' ? '<=' : cond.operator === 'gt' ? '>' : '>=';
      where.push(`(${ordExpr}) ${op} $${paramIdx}`);
      values.push(ordVal);
      paramIdx++;
      continue;
    }

    switch (cond.operator) {
      case 'equals':
        where.push(`${field} = $${paramIdx}`);
        values.push(cond.value);
        paramIdx++;
        break;
      case 'not_equals':
        where.push(`${field} != $${paramIdx}`);
        values.push(cond.value);
        paramIdx++;
        break;
      case 'contains':
        where.push(`${field} ILIKE $${paramIdx}`);
        values.push(`%${cond.value}%`);
        paramIdx++;
        break;
      case 'not_contains':
        where.push(`${field} NOT ILIKE $${paramIdx}`);
        values.push(`%${cond.value}%`);
        paramIdx++;
        break;
    }
  }

  const joiner = logic === 'any' ? ' OR ' : ' AND ';
  // The first condition (status != deleted) is always AND'd; user conditions are grouped
  const userConditions = where.slice(1);
  let whereClause = where[0];
  if (userConditions.length > 0) {
    whereClause += ` AND (${userConditions.join(joiner)})`;
  }

  let orderBy: string;
  switch (sortBy) {
    case 'priority':
      orderBy = `CASE priority WHEN 'highest' THEN 1 WHEN 'high' THEN 2 WHEN 'default' THEN 3 WHEN 'low' THEN 4 WHEN 'lowest' THEN 5 END`;
      break;
    case 'category': orderBy = 'category'; break;
    case 'status':
      orderBy = `CASE status WHEN 'backlog' THEN 1 WHEN 'not_started' THEN 2 WHEN 'started' THEN 3 WHEN 'completed' THEN 4 WHEN 'verified' THEN 5 WHEN 'archive' THEN 6 END`;
      break;
    default: orderBy = 'created_at'; break;
  }
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC';

  const result = await db.query<Ticket>(
    `SELECT * FROM tickets WHERE ${whereClause} ORDER BY ${orderBy} ${dir}, id DESC`,
    values,
  );
  return result.rows;
}

// --- Tags ---

export async function getAllTags(): Promise<string[]> {
  const db = await getDb();
  const result = await db.query<{ tags: string }>(`SELECT DISTINCT tags FROM tickets WHERE tags != '[]' AND status != 'deleted'`);
  const tagSet = new Set<string>();
  for (const row of result.rows) {
    try {
      const parsed = JSON.parse(row.tags);
      if (Array.isArray(parsed)) {
        for (const tag of parsed) {
          if (typeof tag === 'string' && tag.trim()) tagSet.add(tag.trim());
        }
      }
    } catch { /* ignore bad JSON */ }
  }
  return Array.from(tagSet).sort();
}

// --- Categories ---

export async function getCategories(): Promise<CategoryDef[]> {
  const settings = await getSettings();
  if (settings.categories) {
    try {
      const parsed = JSON.parse(settings.categories);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    } catch { /* invalid JSON, use defaults */ }
  }
  return DEFAULT_CATEGORIES;
}

export async function saveCategories(categories: CategoryDef[]): Promise<void> {
  await updateSetting('categories', JSON.stringify(categories));
}

// --- Settings ---

export async function getSettings(): Promise<Record<string, string>> {
  const db = await getDb();
  const result = await db.query<{ key: string; value: string }>('SELECT key, value FROM settings');
  const settings: Record<string, string> = {};
  for (const row of result.rows) {
    settings[row.key] = row.value;
  }
  return settings;
}

export async function updateSetting(key: string, value: string): Promise<void> {
  const db = await getDb();
  await db.query(
    `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2`,
    [key, value]
  );
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

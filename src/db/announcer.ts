/**
 * §78 Announcer (HS-8745) — persistence for AI-generated announcement entries.
 * One row per narrated entry; per-project (uses the active project's DB via
 * `getDb()`). Entries are persisted so the reel is seekable / replayable rather
 * than a transient stream.
 */
import { getDb } from './connection.js';

export interface Announcement {
  id: number;
  created_at: string;
  covers_from: string | null;
  covers_to: string | null;
  title: string;
  script: string;
  position: number;
  dismissed: boolean;
}

/** One generated entry before persistence. */
export interface NewAnnouncement {
  title: string;
  script: string;
}

/**
 * Insert a batch of generated entries covering the signal range
 * `[coversFrom, coversTo]`. `position` continues from the current max so a new
 * generation appends after existing entries (preserving playback order).
 */
export async function insertAnnouncements(
  entries: readonly NewAnnouncement[],
  coversFrom: string | null,
  coversTo: string | null,
): Promise<Announcement[]> {
  if (entries.length === 0) return [];
  const db = await getDb();
  const maxRow = await db.query<{ max: number | null }>(`SELECT MAX(position) AS max FROM announcements`);
  let pos = (maxRow.rows[0]?.max ?? 0) + 1;
  const out: Announcement[] = [];
  for (const e of entries) {
    const res = await db.query<Announcement>(
      `INSERT INTO announcements (covers_from, covers_to, title, script, position)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [coversFrom, coversTo, e.title, e.script, pos],
    );
    out.push(res.rows[0]);
    pos++;
  }
  return out;
}

/** The latest `covers_to` across all entries — the high-water mark of what
 *  generation has already summarized, so a re-generate doesn't re-cover work
 *  that's been turned into entries but not yet listened to. */
export async function getLatestCoversTo(): Promise<string | null> {
  const db = await getDb();
  const res = await db.query<{ max: string | Date | null }>(`SELECT MAX(covers_to) AS max FROM announcements`);
  const max = res.rows[0]?.max ?? null;
  // PGLite hands back TIMESTAMPTZ as a Date / PG-format string; normalize to ISO
  // so `effectiveSince`'s lexical compare against the ISO cursor is correct
  // (a raw `2026-06-05 03:00:00+00` mis-sorts vs an ISO `…T…` on the separator).
  return max === null ? null : new Date(max).toISOString();
}

/** List the active (non-dismissed) entries in playback order. */
export async function getActiveAnnouncements(): Promise<Announcement[]> {
  const db = await getDb();
  const res = await db.query<Announcement>(
    `SELECT * FROM announcements WHERE dismissed = false ORDER BY position ASC, id ASC`,
  );
  return res.rows;
}

/** Mark a single entry dismissed ("mark uninteresting"). Returns the row, or null. */
export async function dismissAnnouncement(id: number): Promise<Announcement | null> {
  const db = await getDb();
  const res = await db.query<Announcement>(
    `UPDATE announcements SET dismissed = true WHERE id = $1 RETURNING *`,
    [id],
  );
  return res.rows[0] ?? null;
}

/** Delete every announcement (the "clear / reset the reel" path). Returns the count removed. */
export async function clearAnnouncements(): Promise<number> {
  const db = await getDb();
  const res = await db.query<Announcement>(`DELETE FROM announcements RETURNING id`);
  return res.rows.length;
}

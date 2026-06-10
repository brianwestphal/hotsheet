/**
 * §78 Announcer (HS-8745) — persistence for AI-generated announcement entries.
 * One row per narrated entry; per-project (uses the active project's DB via
 * `getDb()`). Entries are persisted so the reel is seekable / replayable rather
 * than a transient stream.
 */
import { EmphasisArraySchema, type Visual, VisualsArraySchema } from '../schemas.js';
import { getDb } from './connection.js';
import { getSettings } from './settings.js';

/** HS-8803 — grace window after an entry is listened to before it's hidden from
 *  the reel, so the user can scrub back if needed. */
export const LISTENED_GRACE_MS = 60 * 60 * 1000; // 1 hour

export interface Announcement {
  id: number;
  created_at: string;
  covers_from: string | null;
  covers_to: string | null;
  title: string;
  script: string;
  position: number;
  dismissed: boolean;
  /** Key phrases (verbatim substrings of `script`) the PIP emphasizes (HS-8749). */
  emphasis: string[];
  /** Visual specs (today: code diffs) the PIP renders alongside the script (HS-8772). */
  visuals: Visual[];
  /** Wall-clock (ISO) the user last listened to this entry, or null if never
   *  heard. Drives the "first non-listened" start + the 1h-grace clear (HS-8803). */
  listened_at: string | null;
}

/** One generated entry before persistence. */
export interface NewAnnouncement {
  title: string;
  script: string;
  emphasis?: string[];
  visuals?: Visual[];
}

/** The raw `announcements` row — `emphasis` / `visuals` are JSON-encoded TEXT
 *  columns; `listened_at` comes back as a Date / PG-format string from PGLite. */
interface AnnouncementRow extends Omit<Announcement, 'emphasis' | 'visuals' | 'listened_at'> {
  emphasis: string;
  visuals: string;
  listened_at: string | Date | null;
}

/** Parse a raw row into a domain `Announcement` (decoding the JSON columns). */
function toAnnouncement(row: AnnouncementRow): Announcement {
  let emphasis: string[] = [];
  try {
    const parsed = EmphasisArraySchema.safeParse(JSON.parse(row.emphasis));
    if (parsed.success) emphasis = parsed.data;
  } catch { /* corrupt/legacy → no emphasis */ }
  let visuals: Visual[] = [];
  try {
    const parsed = VisualsArraySchema.safeParse(JSON.parse(row.visuals));
    if (parsed.success) visuals = parsed.data;
  } catch { /* corrupt/legacy → no visuals */ }
  const { emphasis: _emph, visuals: _vis, listened_at, ...rest } = row;
  // Normalize TIMESTAMPTZ (Date / `2026-… +00` string) to ISO so the client's
  // comparisons match the other ISO timestamps.
  return { ...rest, emphasis, visuals, listened_at: listened_at === null ? null : new Date(listened_at).toISOString() };
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
    const res = await db.query<AnnouncementRow>(
      `INSERT INTO announcements (covers_from, covers_to, title, script, position, emphasis, visuals)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [coversFrom, coversTo, e.title, e.script, pos, JSON.stringify(e.emphasis ?? []), JSON.stringify(e.visuals ?? [])],
    );
    out.push(toAnnouncement(res.rows[0]));
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

/**
 * HS-8803 — one-time backlog backfill. The old behavior never cleared listened
 * entries, so reels accumulated (a user reported 63). On first read after this
 * shipped, mark the **already-heard** backlog — entries created at/before the
 * legacy close-cursor (`announcer_last_listened_at`, which lives in settings.json)
 * — as listened far enough in the past that the 1h-grace filter clears them at
 * once. Genuinely newer/unheard entries (created after the cursor) stay NULL and
 * are kept. Guarded by a DB sentinel so it runs exactly once per project; a
 * close-without-listening can't re-trigger it.
 */
async function ensureListenedBackfill(): Promise<void> {
  const db = await getDb();
  const done = await db.query(`SELECT 1 FROM settings WHERE key = 'plugin:announcer_listened_backfilled'`);
  if (done.rows.length > 0) return;
  // Index access is typed `string`, but the key may be absent at runtime → widen
  // so the empty/missing guard below is type-honest.
  const cursor: string | undefined = (await getSettings())['announcer_last_listened_at'];
  if (cursor) {
    await db.query(
      `UPDATE announcements SET listened_at = now() - interval '2 hours'
        WHERE listened_at IS NULL AND created_at <= $1::timestamptz`,
      [cursor],
    );
  }
  await db.query(
    `INSERT INTO settings (key, value) VALUES ('plugin:announcer_listened_backfilled', '1') ON CONFLICT (key) DO NOTHING`,
  );
}

/**
 * List the active entries in playback order: non-dismissed, and EXCLUDING ones
 * listened to more than the grace window ago (HS-8803 — so heard pages clear an
 * hour after listening rather than piling up). Never-heard (`listened_at IS NULL`)
 * and recently-heard entries are kept.
 */
export async function getActiveAnnouncements(): Promise<Announcement[]> {
  await ensureListenedBackfill();
  const db = await getDb();
  const res = await db.query<AnnouncementRow>(
    `SELECT * FROM announcements
       WHERE dismissed = false
         AND (listened_at IS NULL OR listened_at >= now() - ($1::bigint * interval '1 millisecond'))
       ORDER BY position ASC, id ASC`,
    [LISTENED_GRACE_MS],
  );
  return res.rows.map(toAnnouncement);
}

/**
 * HS-8803 — mark an entry listened (now), and reset the grace timer for every
 * LATER entry that's already been heard, so going back to an earlier page keeps
 * the ones after it from expiring while the user re-listens. Never-heard later
 * entries are left untouched (they stay "first non-listened" candidates).
 */
export async function markAnnouncementListened(id: number): Promise<void> {
  const db = await getDb();
  await db.query(
    `UPDATE announcements SET listened_at = now()
       WHERE id = $1
          OR (listened_at IS NOT NULL
              AND position > COALESCE((SELECT position FROM announcements WHERE id = $1), 2147483647))`,
    [id],
  );
}

/** Mark a single entry dismissed ("mark uninteresting"). Returns the row, or null. */
export async function dismissAnnouncement(id: number): Promise<Announcement | null> {
  const db = await getDb();
  const res = await db.query<AnnouncementRow>(
    `UPDATE announcements SET dismissed = true WHERE id = $1 RETURNING *`,
    [id],
  );
  return res.rows.map(toAnnouncement)[0] ?? null;
}

/** Delete every announcement (the "clear / reset the reel" path). Returns the count removed. */
export async function clearAnnouncements(): Promise<number> {
  const db = await getDb();
  const res = await db.query<Announcement>(`DELETE FROM announcements RETURNING id`);
  return res.rows.length;
}

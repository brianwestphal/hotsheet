/**
 * §78 Announcer (HS-8804) — persist the live PIP session so playback survives a
 * reload / app relaunch. We remember the **context**, the **playback position**
 * (the current entry, by id + owning project), the **play/paused** state, and
 * the **open vs minimized** state, so on next launch the announcer comes back
 * exactly where it was.
 *
 * Stored in `localStorage` (like the PIP's position / expanded prefs in
 * `announcerPip.tsx`) — it's a pure client UI state with no server round-trip.
 * `resolveRestoreIndex` is pure (no DOM / storage) so it's unit-testable; the
 * PIP supplies the freshly-loaded reel.
 */
import { z } from 'zod';

const SESSION_KEY = 'hotsheet:announcer-session';

const AnnouncerSessionSchema = z.object({
  /** `ALL_PROJECTS` sentinel or a specific project secret. */
  context: z.string(),
  /** The current entry's id, or null when the reel was empty at save time. */
  entryId: z.number().nullable(),
  /** The current entry's owning project — entry ids aren't unique across
   *  projects, so the id alone can't re-find the row in an "All Projects" reel. */
  entryProjectSecret: z.string().nullable(),
  /** Was the reel actively speaking (vs paused / done)? */
  playing: z.boolean(),
  /** Was the panel minimized into the Listen button? */
  minimized: z.boolean(),
});
export type AnnouncerSession = z.infer<typeof AnnouncerSessionSchema>;

/** Persist the current session snapshot. Best-effort (no-op in private mode). */
export function saveAnnouncerSession(session: AnnouncerSession): void {
  try { window.localStorage.setItem(SESSION_KEY, JSON.stringify(session)); } catch { /* private mode etc. */ }
}

/** Load the persisted session, or null when absent / corrupt / storage disabled. */
export function loadAnnouncerSession(): AnnouncerSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_KEY);
    if (raw === null) return null;
    const parsed = AnnouncerSessionSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Forget the session (the user closed the PIP, or it can't be restored). */
export function clearAnnouncerSession(): void {
  try { window.localStorage.removeItem(SESSION_KEY); } catch { /* private mode etc. */ }
}

/**
 * Resolve the saved entry to an index in a freshly-loaded reel. Matches by
 * (id, owning project) so it's correct in an "All Projects" reel where ids can
 * collide across projects. Returns 0 (the first remaining entry) when the saved
 * entry is gone — e.g. it was dismissed, or HS-8803 later filters out
 * already-listened pages — so restore lands somewhere sensible rather than
 * failing. Returns -1 only for an empty reel (nothing to restore).
 *
 * Pure (no DOM / storage) for unit testing; generic over anything carrying an
 * `id` + `projectSecret` so it needn't import the PIP's `ReelEntry`.
 */
export function resolveRestoreIndex(
  reel: readonly { id: number; projectSecret: string }[],
  session: Pick<AnnouncerSession, 'entryId' | 'entryProjectSecret'>,
): number {
  if (reel.length === 0) return -1;
  if (session.entryId === null) return 0;
  const idx = reel.findIndex(e =>
    e.id === session.entryId
    && (session.entryProjectSecret === null || e.projectSecret === session.entryProjectSecret));
  return idx >= 0 ? idx : 0;
}

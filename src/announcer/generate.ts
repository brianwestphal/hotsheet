/**
 * §78 Announcer — the shared "generate one batch" core (HS-8750 live mode 2a).
 *
 * Extracted from the `POST /api/announcer/generate` route so the **live-mode
 * generator loop** (`liveGenerator.ts`) and the manual after-the-fact Listen
 * path run the exact same collect → summarize → persist → record pipeline.
 * Assumes the caller has already bound the target project's DB context
 * (`runWithDataDir`); only `dataDir` (for the markdown-sync notify) and
 * `projectSecret` (for usage accounting) are threaded in explicitly.
 */
import { getLatestCoversTo, insertAnnouncements } from '../db/announcer.js';
import { recordAnnouncerUsage } from '../db/announcerUsage.js';
import { getSettings } from '../db/queries.js';
import { notifyMutation } from '../routes/notify.js';
import { collectWorkSignals } from './collectSignals.js';
import { DEFAULT_ANNOUNCER_MODEL } from './models.js';
import { summarizeWork } from './summarize.js';

export const ANNOUNCER_ENABLED_KEY = 'announcer_enabled';
export const ANNOUNCER_CURSOR_KEY = 'announcer_last_listened_at';

/** Whether the active project has opted in. */
export async function isAnnouncerEnabled(): Promise<boolean> {
  return (await getSettings())[ANNOUNCER_ENABLED_KEY] === 'true';
}

/** Latest of (last-listened cursor, last-generated covers_to) — so a re-generate
 *  picks up where it left off rather than re-covering work already turned into
 *  entries but not yet heard. Shared by the manual + live paths. */
export async function effectiveSince(override?: string): Promise<string | null> {
  if (override !== undefined && override !== '') return override;
  const cursor = (await getSettings())[ANNOUNCER_CURSOR_KEY];
  const latest = await getLatestCoversTo();
  const candidates = [cursor, latest].filter((v): v is string => typeof v === 'string' && v !== '');
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (a > b ? a : b));
}

export interface GenerateOnceArgs {
  dataDir: string;
  projectSecret: string;
  apiKey: string;
  model: string;
  /** Override the "since" cursor; default = `effectiveSince()`. */
  since?: string;
}

/**
 * Run one generation pass for the currently-bound project: collect signals
 * since the cursor, summarize, persist + record usage, and wake pollers.
 * Returns the inserted rows (empty when there was nothing new). Throws if the
 * Anthropic call fails — callers decide how to surface it (route → 502, live
 * generator → log + continue).
 */
export async function generateAnnouncementsOnce(args: GenerateOnceArgs): Promise<{ rows: Awaited<ReturnType<typeof insertAnnouncements>>; generatedCount: number }> {
  const since = await effectiveSince(args.since);
  const signals = await collectWorkSignals(since);
  if (signals.count === 0) return { rows: [], generatedCount: 0 };

  const result = await summarizeWork(signals.material, { apiKey: args.apiKey, model: args.model });

  if (result.usage !== null) {
    await recordAnnouncerUsage({
      projectSecret: args.projectSecret,
      model: args.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
  }

  const rows = await insertAnnouncements(result.entries, signals.coversFrom, signals.coversTo);
  notifyMutation(args.dataDir);
  return { rows, generatedCount: rows.length };
}

export { DEFAULT_ANNOUNCER_MODEL };

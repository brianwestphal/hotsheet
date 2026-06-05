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
import { getActiveAnnouncements, getLatestCoversTo, insertAnnouncements } from '../db/announcer.js';
import { recordAnnouncerUsage } from '../db/announcerUsage.js';
import { getSettings } from '../db/queries.js';
import { notifyMutation } from '../routes/notify.js';
import { collectWorkSignals } from './collectSignals.js';
import { getDismissedTopics } from './dismissedTopics.js';
import { DEFAULT_ANNOUNCER_MODEL } from './models.js';
import { type Compression, summarizeWork } from './summarize.js';

/** Above this many unplayed (active) entries the live generator compresses
 *  harder so narration can catch up (HS-8768). */
export const BACKLOG_HIGH_THRESHOLD = 6;

/** Map the current unplayed backlog to a summarization altitude. */
export function backlogCompressionLevel(activeCount: number): Compression {
  return activeCount >= BACKLOG_HIGH_THRESHOLD ? 'high' : 'normal';
}

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
  /** Last gate before the (paid) summarize call — return false to skip it
   *  (HS-8770 live-mode call budget). Checked only when there ARE signals. */
  canSummarize?: () => boolean;
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

  // HS-8770 — the live-mode call budget gates the paid summarize; over budget,
  // skip and let the work roll into the next (larger) batch.
  if (args.canSummarize !== undefined && !args.canSummarize()) return { rows: [], generatedCount: 0 };

  // HS-8768 — compress harder when the unplayed backlog is large; HS-8769 —
  // omit topics the listener has marked uninteresting.
  const [backlog, dismissedTopics] = await Promise.all([getActiveAnnouncements(), getDismissedTopics()]);
  const result = await summarizeWork(signals.material, {
    apiKey: args.apiKey,
    model: args.model,
    compression: backlogCompressionLevel(backlog.length),
    dismissedTopics,
  });

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

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
import { readFileSettings } from '../file-settings.js';
import { readGlobalConfig } from '../global-config.js';
import { notifyMutation } from '../routes/notify.js';
import { listAnthropicModels } from './anthropicModels.js';
import { isAppleFoundationAvailable } from './appleFoundation.js';
import { collectWorkSignals } from './collectSignals.js';
import { getDismissedTopics } from './dismissedTopics.js';
import { resolveAnnouncerKey } from './key.js';
import { isLocalProviderAvailable } from './localProvider.js';
import { ANNOUNCER_MODELS, APPLE_FOUNDATION_MODEL_ID, DEFAULT_ANNOUNCER_MODEL, providerForModel, resolveBestModelForSelection } from './models.js';
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

/**
 * The model to summarize with (HS-8790). The user's explicit `announcerModel`
 * choice wins; otherwise default to **Apple Foundation Models when available**
 * (on-device + free), falling back to the cheapest Anthropic model. Shared by
 * the generate route + the live generator so both honor the same default.
 *
 * HS-8853 — best-effort same-family upgrade: if the saved choice is an Anthropic
 * model the active key no longer offers (e.g. a retired `claude-sonnet-4-5`),
 * resolve it to the newest available model in the **same family**
 * (`claude-sonnet-4-6`) rather than running an invalid id or jumping families.
 * Discovery failure (no key / unreachable) leaves the saved id untouched.
 */
export async function resolveAnnouncerModel(): Promise<string> {
  const chosen = readGlobalConfig().announcerModel;
  if (chosen === undefined) {
    return (await isAppleFoundationAvailable()) ? APPLE_FOUNDATION_MODEL_ID : DEFAULT_ANNOUNCER_MODEL;
  }
  if (providerForModel(chosen) === 'anthropic') {
    const key = await resolveAnnouncerKey();
    if (key !== null) {
      const available = (await listAnthropicModels(key)).map(m => m.id);
      if (available.length > 0) return resolveBestModelForSelection(chosen, available) ?? chosen;
    }
  }
  return chosen;
}

/**
 * HS-8853 — the Anthropic models to offer in the settings dropdown: the
 * `claude-*` models the active key actually exposes (discovered via the Models
 * API), or the static fallback set when there's no key / discovery failed (so
 * the dropdown is never empty). Each entry is `{id, label}`.
 */
export async function listAnnouncerAnthropicModels(): Promise<{ id: string; label: string }[]> {
  const key = await resolveAnnouncerKey();
  if (key !== null) {
    const discovered = await listAnthropicModels(key);
    if (discovered.length > 0) return discovered;
  }
  return ANNOUNCER_MODELS.filter(m => m.provider === 'anthropic').map(m => ({ id: m.id, label: m.label }));
}

/** Whether a model's provider is ready to summarize, and the credential it needs.
 *  Single source of truth for the gating every generate path shares (HS-8790 +
 *  HS-8792): `anthropic` needs the user's key; `apple` needs the on-device helper
 *  available; `local` needs the configured endpoint reachable. `apiKey` is set
 *  only for the Anthropic path; `error` carries a user-facing reason when not ready. */
export interface ProviderReadiness { ready: boolean; apiKey: string | null; error: string | null }
export async function prepareSummarizationProvider(model: string): Promise<ProviderReadiness> {
  const provider = providerForModel(model);
  if (provider === 'apple') {
    return (await isAppleFoundationAvailable())
      ? { ready: true, apiKey: null, error: null }
      : { ready: false, apiKey: null, error: 'Apple Foundation Models are not available on this machine' };
  }
  if (provider === 'local') {
    return (await isLocalProviderAvailable())
      ? { ready: true, apiKey: null, error: null }
      : { ready: false, apiKey: null, error: 'No local model endpoint is reachable' };
  }
  const apiKey = await resolveAnnouncerKey();
  return apiKey === null
    ? { ready: false, apiKey: null, error: 'No Anthropic API key configured' }
    : { ready: true, apiKey, error: null };
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
  /** Anthropic key — required for Anthropic models, `null` for on-device
   *  providers (Apple Foundation Models), which need no key. */
  apiKey: string | null;
  model: string;
  /** Override the "since" cursor; default = `effectiveSince()`. */
  since?: string;
  /** Last gate before the (paid) summarize call — return false to skip it
   *  (HS-8770 live-mode call budget). Checked only when there ARE signals. */
  canSummarize?: () => boolean;
  /** HS-8789 — include the §67 telemetry event stream (in-progress prompts +
   *  tool activity) as a signal source so live mode narrates mid-task. Set only
   *  by the live generator; ignored for a project with telemetry disabled. */
  includeTelemetry?: boolean;
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
  // HS-8789 — feed telemetry only when the live generator asks AND the project
  // hasn't opted out of telemetry (default-on; only an explicit `false` opts out).
  const telemetryEnabled = readFileSettings(args.dataDir)['telemetry_enabled'] !== false;
  const includeTelemetry = args.includeTelemetry === true && telemetryEnabled;
  const signals = await collectWorkSignals(since, { projectSecret: args.projectSecret, includeTelemetry });
  if (signals.count === 0) return { rows: [], generatedCount: 0 };

  // HS-8770 — the live-mode call budget gates the paid summarize; over budget,
  // skip and let the work roll into the next (larger) batch.
  if (args.canSummarize !== undefined && !args.canSummarize()) return { rows: [], generatedCount: 0 };

  // HS-8768 — compress harder when the unplayed backlog is large; HS-8769 —
  // omit topics the listener has marked uninteresting.
  const [backlog, dismissedTopics] = await Promise.all([getActiveAnnouncements(), getDismissedTopics()]);
  // HS-8792 — the local provider reads its endpoint + model from the global
  // config (ignored by the Anthropic/Apple paths).
  const cfg = readGlobalConfig();
  // HS-8805 — if the model was AUTO-selected (no explicit `announcerModel`) and
  // resolved to an on-device provider, hand `summarizeWork` an Anthropic key to
  // fall back to when the on-device helper fails inference (e.g. Apple FM exits
  // code 4 despite `--probe` reporting available). An EXPLICIT on-device choice
  // is respected (no fallback key resolved), so a privacy/cost preference is
  // never silently overridden by a paid cloud call.
  const autoSelected = cfg.announcerModel === undefined;
  const onDevice = providerForModel(args.model) === 'apple' || providerForModel(args.model) === 'local';
  const anthropicFallbackKey = autoSelected && onDevice ? await resolveAnnouncerKey() : null;
  const result = await summarizeWork(signals.material, {
    apiKey: args.apiKey,
    model: args.model,
    compression: backlogCompressionLevel(backlog.length),
    dismissedTopics,
    localEndpoint: cfg.announcerLocalEndpoint,
    localModel: cfg.announcerLocalModel,
    anthropicFallbackKey,
    // HS-8800 — drop model-rated-`low` entries only on the live mid-task path
    // (its material carries "[in progress]" telemetry churn). The after-the-fact
    // "Listen" digest (includeTelemetry false) keeps them, so a minor completion
    // note isn't silently dropped to an empty "nothing new" reel.
    excludeLowImportance: includeTelemetry,
  });

  if (result.usage !== null) {
    await recordAnnouncerUsage({
      projectSecret: args.projectSecret,
      // HS-8805 — attribute cost to the model that ACTUALLY ran (the Anthropic
      // fallback model when the on-device path failed over), not the requested
      // on-device id (which `announcerCost` prices at $0).
      model: result.modelUsed ?? args.model,
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
    });
  }

  const rows = await insertAnnouncements(result.entries, signals.coversFrom, signals.coversTo);
  notifyMutation(args.dataDir);
  return { rows, generatedCount: rows.length };
}

export { DEFAULT_ANNOUNCER_MODEL };

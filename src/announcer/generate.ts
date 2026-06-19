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
import { isLocalProviderAvailable, resolveLocalModel } from './localProvider.js';
import { ANNOUNCER_MODELS, type AnnouncerProvider, APPLE_FOUNDATION_MODEL_ID, DEFAULT_ANNOUNCER_MODEL, LOCAL_MODEL_ID, providerForModel, resolveBestModelForSelection } from './models.js';
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
 *
 * HS-8872 — availability-aware fallback for an explicitly-chosen ON-DEVICE
 * provider. An Apple / local choice can become unavailable on the current
 * machine or build (no Apple Intelligence support, a beta bundle missing the
 * helper, a stopped local endpoint, or a local endpoint that's up but has no
 * model configured). Returning the unavailable id made EVERY generate hard-fail
 * with a misleading "<provider> not available" 400 — the "constantly nothing +
 * warning message" report — even when another provider was ready. When the
 * chosen on-device provider isn't ready we fall back to the first working one,
 * preferring the other free/on-device option before the (paid) cheapest Anthropic
 * model, so a privacy/cost preference is honored where one still works.
 */
export async function resolveAnnouncerModel(): Promise<string> {
  const chosen = readGlobalConfig().announcerModel;
  if (chosen === undefined) {
    return (await isAppleFoundationAvailable()) ? APPLE_FOUNDATION_MODEL_ID : DEFAULT_ANNOUNCER_MODEL;
  }
  const provider = providerForModel(chosen);
  if (provider === 'anthropic') {
    const key = await resolveAnnouncerKey();
    if (key !== null) {
      const available = (await listAnthropicModels(key)).map(m => m.id);
      if (available.length > 0) return resolveBestModelForSelection(chosen, available) ?? chosen;
    }
    return chosen;
  }
  // On-device choice (apple / local): keep it when ready, else recover.
  if (await isOnDeviceProviderReady(provider)) return chosen;
  return (await firstReadyAnnouncerModel()) ?? chosen;
}

/**
 * HS-8805 / HS-8891 — pure fallback policy for `generateAnnouncementsOnce`. Given
 * the RESOLVED model's provider, whether the model was auto-selected, and the
 * user's configured `announcerFallbackModel`, decide the on-device-failure
 * fallback:
 *  - **auto path (HS-8805):** an auto-selected on-device model falls back to
 *    Anthropic at the default model — `fallbackModel` undefined, key needed.
 *  - **configured path (HS-8891):** an EXPLICIT Apple primary with a non-empty
 *    configured fallback uses that model — key needed only for an Anthropic
 *    fallback (a `local` fallback needs no key).
 *  - **none:** an explicit on-device choice with no configured fallback (the
 *    pre-HS-8891 "respect the privacy/cost choice" behavior) — Apple failure
 *    surfaces as an error, no cloud call.
 * Exported for unit testing.
 */
export interface AnnouncerFallbackDecision { fallbackModel: string | undefined; needsAnthropicKey: boolean }
export function decideAnnouncerFallback(
  provider: AnnouncerProvider,
  autoSelected: boolean,
  configuredFallbackModel: string | undefined,
): AnnouncerFallbackDecision {
  const onDevice = provider === 'apple' || provider === 'local';
  if (autoSelected && onDevice) {
    // Legacy auto fallback → Anthropic at the default model (summarize.ts).
    return { fallbackModel: undefined, needsAnthropicKey: true };
  }
  // Configured fallback is scoped to an explicit Apple primary (HS-8891 decision).
  if (provider === 'apple' && configuredFallbackModel !== undefined && configuredFallbackModel !== '') {
    return {
      fallbackModel: configuredFallbackModel,
      needsAnthropicKey: providerForModel(configuredFallbackModel) === 'anthropic',
    };
  }
  return { fallbackModel: undefined, needsAnthropicKey: false };
}

/** Whether an on-device provider can actually summarize right now. `apple` needs
 *  the on-device helper; `local` needs a reachable endpoint AND a configured model
 *  (a reachable endpoint with no `announcerLocalModel` set still throws at the
 *  summarize call, so it isn't "ready"). Anthropic is gated separately by key. */
async function isOnDeviceProviderReady(provider: AnnouncerProvider): Promise<boolean> {
  if (provider === 'apple') return isAppleFoundationAvailable();
  if (provider === 'local') return (await isLocalProviderAvailable()) && resolveLocalModel() !== '';
  return true;
}

/** HS-8872 — the first announcer model whose provider is ready, preferring the
 *  free/on-device options (Apple, then a configured local endpoint) before the
 *  cheapest Anthropic model. `null` when nothing is configured/available, so the
 *  caller surfaces the original (accurate) provider error rather than masking it. */
async function firstReadyAnnouncerModel(): Promise<string | null> {
  if (await isAppleFoundationAvailable()) return APPLE_FOUNDATION_MODEL_ID;
  if ((await isLocalProviderAvailable()) && resolveLocalModel() !== '') return LOCAL_MODEL_ID;
  if ((await resolveAnnouncerKey()) !== null) return DEFAULT_ANNOUNCER_MODEL;
  return null;
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
  // HS-8805 / HS-8891 — decide whether (and how) to fall back when the on-device
  // model fails inference. `decideAnnouncerFallback` is the pure policy; we then
  // resolve the Anthropic key only if it's actually needed.
  const decision = decideAnnouncerFallback(providerForModel(args.model), cfg.announcerModel === undefined, cfg.announcerFallbackModel);
  const anthropicFallbackKey = decision.needsAnthropicKey ? await resolveAnnouncerKey() : null;
  const fallbackModel = decision.fallbackModel;
  const result = await summarizeWork(signals.material, {
    apiKey: args.apiKey,
    model: args.model,
    compression: backlogCompressionLevel(backlog.length),
    dismissedTopics,
    localEndpoint: cfg.announcerLocalEndpoint,
    localModel: cfg.announcerLocalModel,
    anthropicFallbackKey,
    fallbackModel,
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

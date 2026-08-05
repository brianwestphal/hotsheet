/**
 * HS-9602 (step 1 of docs/67-beyond-Claude, HS-9599) — which AI tool produced a
 * piece of telemetry.
 *
 * ## Why this exists
 *
 * Every `otel_*` row is anonymous. Everything downstream infers Claude because
 * the metric names happen to be `claude_code.*`, which is true today and is
 * exactly the assumption that has to end: codex links the same OTLP exporter and
 * emits under `codex.*` (measured against codex-cli 0.146.0).
 *
 * The consequence is a labelling problem before it is an aggregation problem.
 * Renaming the dashboard's "Claude Usage" to the project's `ai_tool` would make a
 * codex project claim "Codex Usage" over **Claude's** data, or over an empty
 * chart. **The label has to follow the data**, and nothing recorded what the data
 * was. This module is that record.
 *
 * ## Why the metric NAMESPACE, not `service.name`
 *
 * OTLP's `service.name` is a resource attribute the emitter chooses, and can be
 * overridden by a user's env (`OTEL_SERVICE_NAME`) or a proxy. The metric and
 * event names are the tool's own vocabulary — they cannot be renamed without the
 * tool's own aggregation breaking — so they are the honest signal.
 */
import { claudePlugin } from '../aiTools/plugins/claude.js';
import { listPlugins } from '../aiTools/registry.js';

/** The tool id recorded for telemetry we cannot attribute. Deliberately a real
 *  value rather than null: "we received data and do not know whose" is a
 *  different, reportable state from "no data". */
export const UNKNOWN_EMITTER = 'unknown';

/** Who produced every row written before HS-9602. Claude Code was the only thing
 *  Hot Sheet ever ingested, so this is a historical fact rather than a guess. */
const LEGACY_EMITTER = claudePlugin.id;

/**
 * Prefix → tool id, built from the plugin registry.
 *
 * The mapping lives on each `AiToolPlugin` (`telemetryMetricPrefix`), not in a
 * table here — §132's standing rule is that a tool is defined in ONE place, and
 * the repo's own `no-restricted-syntax` guard enforces it (it caught the first
 * version of this file, which hard-coded both ids).
 *
 * Sorted longest-prefix-first so a future nested namespace cannot be shadowed by
 * a shorter one that happens to be registered earlier.
 */
function emitterPrefixes(): { prefix: string; tool: string }[] {
  return listPlugins()
    .filter(p => typeof p.telemetryMetricPrefix === 'string' && p.telemetryMetricPrefix !== '')
    .map(p => ({ prefix: p.telemetryMetricPrefix ?? '', tool: p.id }))
    .sort((a, b) => b.prefix.length - a.prefix.length);
}

/**
 * The tool that emitted a metric or log-event name, or `unknown`.
 *
 * Pure and total — an unrecognized or empty name is `unknown`, never a throw:
 * this runs on the OTLP ingest path, where a malformed payload must not be able
 * to stop the rest of a batch being recorded.
 */
export function emitterForSignalName(name: string | null | undefined): string {
  if (typeof name !== 'string' || name === '') return UNKNOWN_EMITTER;
  const match = emitterPrefixes().find(e => name.startsWith(e.prefix));
  return match?.tool ?? UNKNOWN_EMITTER;
}

/**
 * Which tool a window's telemetry came from, for labelling.
 *
 * The `legacy` fallback is load-bearing. Every row written before HS-9602 has no
 * emitter recorded, and every one of them is Claude Code's — that was the only
 * thing Hot Sheet ever ingested. Reading "no emitters recorded" as *unknown*
 * would relabel every existing user's dashboard on upgrade; reading it as
 * `claude` is both accurate and invisible. It is a read-time default rather than
 * a data migration precisely because it costs nothing and cannot half-apply.
 *
 * `hasData` distinguishes "old rows, no emitter recorded" (→ claude) from
 * "nothing in this window at all" (→ no tools, so the caller keeps its empty
 * state rather than naming a vendor over a blank chart).
 */
export function resolveWindowEmitters(recorded: readonly string[], hasData: boolean): string[] {
  const distinct = [...new Set(recorded.filter(t => t !== ''))].sort();
  if (distinct.length > 0) return distinct;
  return hasData ? [LEGACY_EMITTER] : [];
}

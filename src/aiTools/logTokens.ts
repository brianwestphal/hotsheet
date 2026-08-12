// HS-9621 — extract disjoint token counts from an OTLP LOG record by consulting
// every registered tool's `telemetryLogTokens` spec. This is the logs-side twin
// of `otelTokenRouting`'s metric routing: codex-cli 0.147.0 reports token usage
// on a `codex.sse_event` log record and emits no token metrics, so without this
// the metrics path never sees a single codex token.
//
// Registry-driven, with no tool-id branch (§132): a new tool becomes ingestible
// by declaring `telemetryLogTokens` on its plugin, nothing here changes.

import { listPlugins } from './registry.js';
import { type DisjointTokenCounts,disjointTokensFromLog } from './tokenMetrics.js';

/** Disjoint token counts from a log record, plus the model and the tool that
 *  owns the event (for emitter attribution). */
export interface LogTokenResult extends DisjointTokenCounts {
  readonly model: string;
  readonly tool: string;
}

/**
 * Resolve a flattened OTLP log record's attributes to disjoint token counts, or
 * `null` when no registered tool claims the event. The first tool whose
 * `telemetryLogTokens` spec matches wins (event names are tool-specific, so at
 * most one matches in practice).
 */
export function extractLogTokens(attrs: Record<string, unknown>): LogTokenResult | null {
  for (const plugin of listPlugins()) {
    const spec = plugin.telemetryLogTokens;
    if (spec === undefined) continue;
    const counts = disjointTokensFromLog(attrs, spec);
    if (counts !== null) return { ...counts, tool: plugin.id };
  }
  return null;
}

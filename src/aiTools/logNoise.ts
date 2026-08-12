// HS-9622 — decide whether an OTLP LOG record is internal noise that should be
// dropped at ingest rather than stored in the JSONL event log. Consults every
// registered tool's `telemetryLogNoise` spec, plus one generic rule that needs no
// tool at all. The logs-side twin of `logTokens.ts` / `otelEmitter.ts`:
// registry-driven, no tool-id branch (§132) — a tool becomes de-noised by
// declaring a spec, nothing here changes.

import { listPlugins } from './registry.js';

/**
 * Codex (a Rust program) sometimes emits a `tracing` record with no `event.name`
 * attribute; its stored name is then the raw source location the OTLP `event_name`
 * FIELD carried (e.g. `event otel/src/metrics/client.rs:277`). These are pure
 * internal tracing, carry no dashboard/timeline value, and attribute to `unknown`.
 * Match a `<file>.<ext>:<line>` tail — the shape of a source location — but ONLY
 * when the record set no `event.name` attribute of its own, so a real semantic
 * event whose name merely contains a colon can never be swept up.
 */
const SOURCE_LOCATION_TAIL = /\.[A-Za-z0-9_]+:\d+\b/;

/**
 * Whether a flattened OTLP log record should be dropped at ingest.
 *
 * @param eventName - the resolved stored event name (HS-9609: the `event.name`
 *   attribute when present, else the OTLP field)
 * @param attrs - the flattened record attributes
 * @param hasEventNameAttr - whether the record set an `event.name` attribute of
 *   its own (distinguishes a semantic event from a raw tracing record whose name
 *   is a source location)
 */
export function isNoiseLogEvent(
  eventName: string,
  attrs: Record<string, unknown>,
  hasEventNameAttr: boolean,
): boolean {
  // Generic, tool-agnostic: a record with no semantic `event.name` whose name is a
  // bare source location is internal tracing chatter from any tool.
  if (!hasEventNameAttr && SOURCE_LOCATION_TAIL.test(eventName)) return true;

  for (const plugin of listPlugins()) {
    const spec = plugin.telemetryLogNoise;
    if (spec === undefined) continue;
    if (spec.dropEventNames.includes(eventName)) return true;
    const keptKinds = spec.keepOnlyKinds?.[eventName];
    if (keptKinds !== undefined) {
      const kind = typeof attrs['event.kind'] === 'string' ? attrs['event.kind'] : '';
      if (!keptKinds.includes(kind)) return true;
    }
  }
  return false;
}

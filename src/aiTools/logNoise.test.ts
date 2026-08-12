// HS-9622 — codex has no per-signal OTLP routing, so it POSTs its whole internal
// `tracing` stream to `/v1/logs`. These pin which of those records are dropped as
// noise at ingest and — critically — which are KEPT (the codex analogs of
// Claude's curated `logs & events` set + what the docs/68 timeline renders), so a
// future over-eager drop can't silently swallow a semantic event.

import { describe, expect, it } from 'vitest';

import { isNoiseLogEvent } from './logNoise.js';

const attr = (kind?: string): Record<string, unknown> => (kind === undefined ? {} : { 'event.kind': kind });

describe('isNoiseLogEvent (codex, HS-9622)', () => {
  it('drops codex internal transport/lifecycle events', () => {
    for (const name of ['codex.startup_phase', 'codex.websocket_connect', 'codex.websocket_request']) {
      expect(isNoiseLogEvent(name, attr(), true)).toBe(true);
    }
  });

  it('drops every codex.sse_event kind EXCEPT response.completed', () => {
    expect(isNoiseLogEvent('codex.sse_event', attr('response.created'), true)).toBe(true);
    expect(isNoiseLogEvent('codex.sse_event', attr('response.output_text.delta'), true)).toBe(true);
    expect(isNoiseLogEvent('codex.sse_event', attr(), true)).toBe(true); // no kind → dropped
    // The token-bearing turn-closer is the one kept kind.
    expect(isNoiseLogEvent('codex.sse_event', attr('response.completed'), true)).toBe(false);
  });

  it('keeps the semantic events the dashboard + timeline need', () => {
    for (const name of ['codex.user_prompt', 'codex.api_request', 'codex.conversation_starts', 'codex.turn_ttft']) {
      expect(isNoiseLogEvent(name, attr(), true)).toBe(false);
    }
  });

  it('drops a raw source-location tracing record only when it set no event.name', () => {
    // codex emits some records with no `event.name` attribute; the stored name is
    // then the Rust source location. hasEventNameAttr=false → drop.
    expect(isNoiseLogEvent('event otel/src/metrics/client.rs:277', {}, false)).toBe(true);
    expect(isNoiseLogEvent('event otel/src/session_telemetry.rs:202', {}, false)).toBe(true);
    // A real semantic event that merely contains a colon-and-digits is never
    // swept up, because it DID set an event.name attribute.
    expect(isNoiseLogEvent('some.event:12', {}, true)).toBe(false);
  });

  it('leaves Claude events (and unknown non-source-location names) untouched', () => {
    expect(isNoiseLogEvent('user_prompt', {}, true)).toBe(false);
    expect(isNoiseLogEvent('claude_code.api_request', {}, true)).toBe(false);
    expect(isNoiseLogEvent('log', {}, false)).toBe(false);
  });
});

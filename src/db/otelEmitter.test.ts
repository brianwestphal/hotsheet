/**
 * HS-9602 — attributing telemetry to the tool that emitted it.
 *
 * The pure half. Both functions run on paths where being wrong is expensive in
 * different directions: `emitterForSignalName` is on the OTLP ingest path (a
 * throw would drop a batch), and `resolveWindowEmitters` decides what the
 * dashboard CLAIMS about whose spend it is showing.
 */
import { describe, expect, it } from 'vitest';

import { emitterForSignalName, resolveWindowEmitters, UNKNOWN_EMITTER } from './otelEmitter.js';

describe('emitterForSignalName (HS-9602)', () => {
  it('attributes Claude Code metrics and events', () => {
    expect(emitterForSignalName('claude_code.cost.usage')).toBe('claude');
    expect(emitterForSignalName('claude_code.token.usage')).toBe('claude');
    expect(emitterForSignalName('claude_code.user_prompt')).toBe('claude');
  });

  it('attributes codex, measured against codex-cli 0.146.0', () => {
    // Real names read out of the shipped binary, not invented.
    expect(emitterForSignalName('codex.api_request')).toBe('codex');
    expect(emitterForSignalName('codex.api_request.duration_ms')).toBe('codex');
    expect(emitterForSignalName('codex.conversation.turn.count')).toBe('codex');
  });

  it('reports an unrecognized namespace as unknown rather than guessing', () => {
    // "we received data and cannot attribute it" is a real, reportable state —
    // and must never be silently folded into Claude, which would inflate one
    // vendor's apparent spend.
    expect(emitterForSignalName('gemini_cli.tokens')).toBe(UNKNOWN_EMITTER);
    expect(emitterForSignalName('something.else')).toBe(UNKNOWN_EMITTER);
  });

  it('is total — a malformed name never throws on the ingest path', () => {
    // A bad payload must not be able to stop the rest of a batch recording.
    expect(emitterForSignalName('')).toBe(UNKNOWN_EMITTER);
    expect(emitterForSignalName(null)).toBe(UNKNOWN_EMITTER);
    expect(emitterForSignalName(undefined)).toBe(UNKNOWN_EMITTER);
  });

  it('does not match a prefix that merely CONTAINS a known namespace', () => {
    // `startsWith`, not `includes` — otherwise a third-party metric mentioning
    // another tool would be misattributed to it.
    expect(emitterForSignalName('vendor.claude_code.shim')).toBe(UNKNOWN_EMITTER);
    expect(emitterForSignalName('my_codex.thing')).toBe(UNKNOWN_EMITTER);
  });
});

describe('resolveWindowEmitters (HS-9602)', () => {
  it('reports the distinct tools recorded, sorted and deduped', () => {
    expect(resolveWindowEmitters(['claude', 'codex', 'claude'], true)).toEqual(['claude', 'codex']);
  });

  it('reads pre-HS-9602 data as Claude — the legacy default', () => {
    // Every row written before this ticket has no emitter recorded, and every
    // one is Claude Code's. Reading them as `unknown` would relabel every
    // existing user's dashboard on upgrade.
    expect(resolveWindowEmitters([], true)).toEqual(['claude']);
  });

  it('names NOTHING for an empty window', () => {
    // The distinction that makes the legacy default safe: no data means no
    // vendor claim, rather than "Claude Usage" over a blank panel.
    expect(resolveWindowEmitters([], false)).toEqual([]);
  });

  it('ignores empty recorded values', () => {
    expect(resolveWindowEmitters(['', 'codex'], true)).toEqual(['codex']);
    expect(resolveWindowEmitters([''], true)).toEqual(['claude']);
  });
});

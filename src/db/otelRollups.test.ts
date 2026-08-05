/**
 * Pure-helper coverage for the §67 telemetry rollups: the prefix-tolerant event
 * matchers `eventNameMatchSql` (SQL fragment) + `isClaudeCodeEvent` (JS-side
 * counterpart). Both exist because Claude Code emits some events bare
 * (`user_prompt`) and some prefixed (`claude_code.user_prompt`); the two must
 * accept the same set, which these tests pin.
 */
import { describe, expect, it } from 'vitest';

import { eventNameMatchSql, isClaudeCodeEvent } from './otelRollups.js';

describe('eventNameMatchSql', () => {
  it('emits an IN clause over the bare form plus EVERY registered tool prefix', () => {
    // HS-9610 — was Claude-only. Until this widened, `codex.api_request`
    // matched nothing and codex work never reached the per-ticket rollup.
    const sql = eventNameMatchSql('event_name', 'user_prompt');
    expect(sql.startsWith(`event_name IN ('user_prompt', `)).toBe(true);
    expect(sql).toContain(`'claude_code.user_prompt'`);
    expect(sql).toContain(`'codex.user_prompt'`);
  });

  it('enumerates KNOWN prefixes rather than accepting any `*.user_prompt`', () => {
    // A wildcard would let an unrelated vendor's identically-named event land
    // on someone's ticket. Every variant must be an exact literal.
    const sql = eventNameMatchSql('event_name', 'user_prompt');
    expect(sql).not.toContain('LIKE');
    expect(sql).not.toContain('%');
  });

  it('uses the column name it is given', () => {
    const sql = eventNameMatchSql('e.name', 'tool_result');
    expect(sql.startsWith(`e.name IN ('tool_result', `)).toBe(true);
    expect(sql).toContain(`'claude_code.tool_result'`);
  });
});

describe('isClaudeCodeEvent', () => {
  it('matches the bare stored name', () => {
    expect(isClaudeCodeEvent('user_prompt', 'user_prompt')).toBe(true);
  });

  it('matches the claude_code-prefixed stored name', () => {
    expect(isClaudeCodeEvent('claude_code.user_prompt', 'user_prompt')).toBe(true);
  });

  it('does not match an unrelated event name', () => {
    expect(isClaudeCodeEvent('api_request', 'user_prompt')).toBe(false);
  });

  it('does not match a different prefix', () => {
    expect(isClaudeCodeEvent('other.user_prompt', 'user_prompt')).toBe(false);
  });

  it('agrees with eventNameMatchSql on the accepted set', () => {
    const accepted = ['tool_decision', 'claude_code.tool_decision'];
    const sql = eventNameMatchSql('event_name', 'tool_decision');
    for (const name of accepted) {
      expect(isClaudeCodeEvent(name, 'tool_decision')).toBe(true);
      expect(sql).toContain(`'${name}'`);
    }
  });
});

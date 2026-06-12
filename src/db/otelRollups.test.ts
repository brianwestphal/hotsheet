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
  it('emits an IN clause over the bare + claude_code-prefixed variants', () => {
    expect(eventNameMatchSql('event_name', 'user_prompt'))
      .toBe(`event_name IN ('user_prompt', 'claude_code.user_prompt')`);
  });

  it('uses the column name it is given', () => {
    expect(eventNameMatchSql('e.name', 'tool_result'))
      .toBe(`e.name IN ('tool_result', 'claude_code.tool_result')`);
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

// HS-9313 — agentDisplayName mapping.
import { describe, expect, it } from 'vitest';

import { agentDisplayName } from './agentName.js';

describe('agentDisplayName', () => {
  it('maps known CLI agents to their display name', () => {
    expect(agentDisplayName('codex')).toBe('Codex');
    expect(agentDisplayName('gemini')).toBe('Gemini');
    expect(agentDisplayName('opencode')).toBe('OpenCode');
    expect(agentDisplayName('goose')).toBe('Goose');
  });

  it('maps editor tools too', () => {
    expect(agentDisplayName('cursor')).toBe('Cursor');
    expect(agentDisplayName('windsurf')).toBe('Windsurf');
    expect(agentDisplayName('copilot')).toBe('Copilot');
  });

  it('auto / claude / unset / unknown → "Claude" (the current channel driver)', () => {
    expect(agentDisplayName('auto')).toBe('Claude');
    expect(agentDisplayName('claude')).toBe('Claude');
    expect(agentDisplayName(undefined)).toBe('Claude');
    expect(agentDisplayName('')).toBe('Claude');
    expect(agentDisplayName('some-future-tool')).toBe('Claude');
  });

  it('is case/whitespace tolerant', () => {
    expect(agentDisplayName(' Codex ')).toBe('Codex');
    expect(agentDisplayName('GEMINI')).toBe('Gemini');
  });
});

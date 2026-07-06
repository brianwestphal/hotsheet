// HS-9338 — the pure agent_backend parse/format (shared server + client).
import { describe, expect, it } from 'vitest';

import { type AgentBackendOverride, formatAgentBackend, parseAgentBackend } from './agentBackendParse.js';

describe('parseAgentBackend (HS-9338)', () => {
  it('auto/empty/unknown/non-string → auto', () => {
    expect(parseAgentBackend('auto')).toEqual({ mode: 'auto' });
    expect(parseAgentBackend('')).toEqual({ mode: 'auto' });
    expect(parseAgentBackend('   ')).toEqual({ mode: 'auto' });
    expect(parseAgentBackend(undefined)).toEqual({ mode: 'auto' });
    expect(parseAgentBackend(42)).toEqual({ mode: 'auto' });
    expect(parseAgentBackend('nonsense')).toEqual({ mode: 'auto' });
  });

  it('forces a transport (case-insensitive), with the claude-channel-mcp alias', () => {
    expect(parseAgentBackend('claude-channel')).toEqual({ mode: 'transport', transport: 'claude-channel', command: null });
    expect(parseAgentBackend('claude-channel-mcp')).toEqual({ mode: 'transport', transport: 'claude-channel', command: null });
    expect(parseAgentBackend('MCP-HOOKS')).toEqual({ mode: 'transport', transport: 'mcp-hooks', command: null });
    expect(parseAgentBackend('acp')).toEqual({ mode: 'transport', transport: 'acp', command: null });
  });

  it('captures the advanced <transport>:<command> form', () => {
    expect(parseAgentBackend('mcp-hooks:my-agent --print')).toEqual({ mode: 'transport', transport: 'mcp-hooks', command: 'my-agent --print' });
    expect(parseAgentBackend('acp:goose acp')).toEqual({ mode: 'transport', transport: 'acp', command: 'goose acp' });
    expect(parseAgentBackend('acp:')).toEqual({ mode: 'transport', transport: 'acp', command: null }); // trailing colon
  });
});

describe('formatAgentBackend (HS-9338)', () => {
  it('auto → "auto"', () => {
    expect(formatAgentBackend({ mode: 'auto' })).toBe('auto');
  });

  it('a bare transport when no command', () => {
    expect(formatAgentBackend({ mode: 'transport', transport: 'claude-channel', command: null })).toBe('claude-channel');
    expect(formatAgentBackend({ mode: 'transport', transport: 'acp', command: null })).toBe('acp');
  });

  it('appends the command for mcp-hooks / acp, but never for claude-channel', () => {
    expect(formatAgentBackend({ mode: 'transport', transport: 'acp', command: 'goose acp' })).toBe('acp:goose acp');
    expect(formatAgentBackend({ mode: 'transport', transport: 'mcp-hooks', command: 'agy' })).toBe('mcp-hooks:agy');
    // claude-channel drops any stray command
    expect(formatAgentBackend({ mode: 'transport', transport: 'claude-channel', command: 'ignored' })).toBe('claude-channel');
    // whitespace-only command is dropped
    expect(formatAgentBackend({ mode: 'transport', transport: 'acp', command: '  ' })).toBe('acp');
  });

  it('round-trips with parseAgentBackend', () => {
    const cases: AgentBackendOverride[] = [
      { mode: 'auto' },
      { mode: 'transport', transport: 'claude-channel', command: null },
      { mode: 'transport', transport: 'mcp-hooks', command: null },
      { mode: 'transport', transport: 'acp', command: 'goose acp' },
    ];
    for (const c of cases) expect(parseAgentBackend(formatAgentBackend(c))).toEqual(c);
  });
});

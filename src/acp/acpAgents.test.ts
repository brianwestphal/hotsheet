import { describe, expect, it } from 'vitest';

import { getChannelServerPath } from '../channel-config.js';
import {
  ACP_PROTOCOL_VERSION,
  buildHotsheetMcpServerEntry,
  isAcpDrivenTool,
  resolveAcpAgentCommand,
} from './acpAgents.js';

// HS-9330 — the deterministic ACP-transport helpers the client will consume.
// Shapes pinned by the live opencode 1.17.9 spike (see acpAgents.ts header).

describe('resolveAcpAgentCommand (HS-9330)', () => {
  it('maps opencode to its `opencode acp` entrypoint (validated live)', () => {
    expect(resolveAcpAgentCommand('opencode')).toEqual({ command: 'opencode', args: ['acp'] });
  });

  it('is case-insensitive and whitespace-tolerant', () => {
    expect(resolveAcpAgentCommand('  OpenCode  ')).toEqual({ command: 'opencode', args: ['acp'] });
  });

  it('returns null for non-ACP / MCP+hooks tools (they use a different transport)', () => {
    for (const t of ['claude', 'antigravity', 'gemini', 'auto', 'cursor', undefined, '', '   ']) {
      expect(resolveAcpAgentCommand(t)).toBeNull();
    }
  });
});

describe('isAcpDrivenTool (HS-9330)', () => {
  it('is true only for tools with a known ACP entrypoint', () => {
    expect(isAcpDrivenTool('opencode')).toBe(true);
    expect(isAcpDrivenTool('OPENCODE')).toBe(true);
    expect(isAcpDrivenTool('antigravity')).toBe(false);
    expect(isAcpDrivenTool('claude')).toBe(false);
    expect(isAcpDrivenTool(undefined)).toBe(false);
  });
});

describe('buildHotsheetMcpServerEntry (HS-9330)', () => {
  it('is a stdio entry reusing the cwd-resolving channel server (rides ACP unchanged)', () => {
    const { command, args } = getChannelServerPath();
    const entry = buildHotsheetMcpServerEntry();
    expect(entry).toEqual({ name: 'hotsheet', command, args, env: [] });
    // env MUST be an array (OpenCode rejects an object) — validated by the spike.
    expect(Array.isArray(entry.env)).toBe(true);
    // No `--data-dir`: the server resolves `.hotsheet` from the agent's launch cwd.
    expect(entry.args).not.toContain('--data-dir');
  });

  it('honors a custom server name', () => {
    expect(buildHotsheetMcpServerEntry('hs-channel').name).toBe('hs-channel');
  });
});

describe('ACP_PROTOCOL_VERSION (HS-9330)', () => {
  it('is 1 (confirmed by opencode initialize)', () => {
    expect(ACP_PROTOCOL_VERSION).toBe(1);
  });
});

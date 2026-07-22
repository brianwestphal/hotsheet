// HS-9339 — the per-agent MCP-hooks (spawn) registry.
import { describe, expect, it } from 'vitest';

import { getMcpHooksAgent, isMcpHooksAiTool, listMcpHooksAgents } from './mcpHooksAgents.js';

describe('mcpHooksAgents registry (HS-9339)', () => {
  it('resolves Antigravity by ai_tool (case-insensitive), with its binary + handlers', () => {
    const agy = getMcpHooksAgent('Antigravity');
    expect(agy).not.toBeNull();
    expect(agy?.aiTool).toBe('antigravity');
    expect(agy?.binary).toBe('agy');
    expect(typeof agy?.spawnRun).toBe('function');
    expect(typeof agy?.ensureMcpConfig).toBe('function');
  });

  it('resolves Codex by ai_tool (case-insensitive), with its binary + handlers (HS-9369)', () => {
    const codex = getMcpHooksAgent('Codex');
    expect(codex).not.toBeNull();
    expect(codex?.aiTool).toBe('codex');
    expect(codex?.binary).toBe('codex');
    expect(typeof codex?.spawnRun).toBe('function');
    expect(typeof codex?.ensureMcpConfig).toBe('function');
  });

  it('returns null for non-registered / Claude / ACP / editor tools + unset', () => {
    expect(getMcpHooksAgent('claude')).toBeNull(); // Claude is claude-channel, not spawn
    expect(getMcpHooksAgent('opencode')).toBeNull(); // ACP, not MCP-hooks
    expect(getMcpHooksAgent('cursor')).toBeNull();
    expect(getMcpHooksAgent('')).toBeNull();
    expect(getMcpHooksAgent(undefined)).toBeNull();
  });

  it('isMcpHooksAiTool mirrors getMcpHooksAgent presence', () => {
    expect(isMcpHooksAiTool('antigravity')).toBe(true);
    expect(isMcpHooksAiTool('claude')).toBe(false);
    expect(isMcpHooksAiTool(undefined)).toBe(false);
  });

  it('every registered agent has a distinct ai_tool + the required fields', () => {
    const agents = listMcpHooksAgents();
    expect(agents.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(agents.map(a => a.aiTool));
    expect(ids.size).toBe(agents.length); // no duplicate ids
    for (const a of agents) {
      expect(a.aiTool).toBe(a.aiTool.toLowerCase());
      expect(a.binary).toBeTruthy();
      expect(typeof a.spawnRun).toBe('function');
      expect(typeof a.ensureMcpConfig).toBe('function');
    }
  });
});

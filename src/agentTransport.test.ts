// HS-9331 — the per-agent drive-transport capability table.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveAgentTransport, resolveEffectiveTransport, resolveProjectTransport } from './agentTransport.js';

describe('resolveAgentTransport (HS-9331)', () => {
  it('routes Antigravity to the MCP+hooks transport (docs/115)', () => {
    expect(resolveAgentTransport('antigravity')).toBe('mcp-hooks');
    expect(resolveAgentTransport('Antigravity')).toBe('mcp-hooks'); // case-insensitive
  });

  it('routes Codex to the MCP+hooks transport (HS-9369 — codex exec drive)', () => {
    expect(resolveAgentTransport('codex')).toBe('mcp-hooks');
    expect(resolveAgentTransport('Codex')).toBe('mcp-hooks');
  });

  it('routes an ACP-native agent to the ACP transport (docs/114)', () => {
    expect(resolveAgentTransport('opencode')).toBe('acp');
    expect(resolveAgentTransport('OpenCode')).toBe('acp');
  });

  it('routes Claude / auto / unset / editor tools to the Claude channel', () => {
    expect(resolveAgentTransport('claude')).toBe('claude-channel');
    expect(resolveAgentTransport('auto')).toBe('claude-channel');
    expect(resolveAgentTransport(undefined)).toBe('claude-channel');
    expect(resolveAgentTransport('')).toBe('claude-channel');
    expect(resolveAgentTransport('cursor')).toBe('claude-channel'); // editor-only tool
    expect(resolveAgentTransport('windsurf')).toBe('claude-channel');
  });

  it('an as-yet-unenabled ACP agent (no entrypoint) falls back to the channel', () => {
    // `goose`/`kiro` have no `resolveAcpAgentCommand` entrypoint yet, so they are NOT
    // ACP-routed until enabled — they fall back to the Claude channel, not a broken ACP.
    expect(resolveAgentTransport('goose')).toBe('claude-channel');
    expect(resolveAgentTransport('kiro')).toBe('claude-channel');
  });
});

describe('resolveProjectTransport (HS-9331)', () => {
  let dir: string;
  let dataDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hs-transport-'));
    dataDir = join(dir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const setTool = (t?: string): void =>
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(t === undefined ? {} : { ai_tool: t }), 'utf-8');

  it('reads ai_tool from the project settings and maps it', () => {
    setTool('antigravity');
    expect(resolveProjectTransport(dataDir)).toBe('mcp-hooks');
    setTool('opencode');
    expect(resolveProjectTransport(dataDir)).toBe('acp');
    setTool('claude');
    expect(resolveProjectTransport(dataDir)).toBe('claude-channel');
  });

  it('defaults to the Claude channel when ai_tool is unset or non-string', () => {
    setTool(undefined);
    expect(resolveProjectTransport(dataDir)).toBe('claude-channel');
  });
});

describe('resolveEffectiveTransport (HS-9338)', () => {
  let dir: string;
  let dataDir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hs-eff-transport-'));
    dataDir = join(dir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const writeSettings = (obj: Record<string, unknown>): void =>
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(obj), 'utf-8');

  it('uses the ai_tool-derived default when agent_backend is auto/absent', () => {
    writeSettings({ ai_tool: 'opencode' });
    expect(resolveEffectiveTransport(dataDir)).toBe('acp');
    writeSettings({ ai_tool: 'opencode', agent_backend: 'auto' });
    expect(resolveEffectiveTransport(dataDir)).toBe('acp');
  });

  it('the agent_backend override wins over the ai_tool-derived transport', () => {
    // ai_tool would derive 'acp', but the override forces the Claude channel.
    writeSettings({ ai_tool: 'opencode', agent_backend: 'claude-channel' });
    expect(resolveEffectiveTransport(dataDir)).toBe('claude-channel');
    // ai_tool='claude' would derive claude-channel, but force mcp-hooks.
    writeSettings({ ai_tool: 'claude', agent_backend: 'mcp-hooks' });
    expect(resolveEffectiveTransport(dataDir)).toBe('mcp-hooks');
  });
});

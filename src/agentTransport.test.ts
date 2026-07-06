// HS-9331 — the per-agent drive-transport capability table.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveAgentTransport, resolveProjectTransport } from './agentTransport.js';

describe('resolveAgentTransport (HS-9331)', () => {
  it('routes Antigravity to the MCP+hooks transport (docs/115)', () => {
    expect(resolveAgentTransport('antigravity')).toBe('mcp-hooks');
    expect(resolveAgentTransport('Antigravity')).toBe('mcp-hooks'); // case-insensitive
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

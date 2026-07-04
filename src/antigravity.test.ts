// HS-9320 — the agy global MCP-config writer.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ANTIGRAVITY_MCP_KEY, ensureAntigravityMcpConfig, removeAntigravityMcpConfig } from './antigravity.js';

let dir: string;
let cfg: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hs-agy-'));
  cfg = join(dir, 'config', 'mcp_config.json');
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function read(): { mcpServers?: Record<string, { command?: string; args?: string[] }> } & Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(cfg, 'utf-8'));
  return parsed as { mcpServers?: Record<string, { command?: string; args?: string[] }> } & Record<string, unknown>;
}

describe('ensureAntigravityMcpConfig', () => {
  it('writes the hotsheet-channel entry to a fresh (missing) config, creating dirs', () => {
    expect(existsSync(cfg)).toBe(false);
    expect(ensureAntigravityMcpConfig(cfg)).toBe(true);
    const server = read().mcpServers?.[ANTIGRAVITY_MCP_KEY];
    expect(server).toBeDefined();
    expect(typeof server?.command).toBe('string');
  });

  it('registers the server WITHOUT a --data-dir arg (cwd-resolving)', () => {
    ensureAntigravityMcpConfig(cfg);
    const args = read().mcpServers?.[ANTIGRAVITY_MCP_KEY]?.args ?? [];
    expect(args).not.toContain('--data-dir');
  });

  it('is idempotent — a second call writes nothing', () => {
    expect(ensureAntigravityMcpConfig(cfg)).toBe(true);
    const before = readFileSync(cfg, 'utf-8');
    expect(ensureAntigravityMcpConfig(cfg)).toBe(false);
    expect(readFileSync(cfg, 'utf-8')).toBe(before);
  });

  it('MERGES — preserves the user\'s other servers + top-level keys', () => {
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(cfg, JSON.stringify({
      ui: { theme: 'Dark' },
      mcpServers: { 'my-other': { command: 'foo', args: ['bar'] } },
    }), 'utf-8');

    expect(ensureAntigravityMcpConfig(cfg)).toBe(true);
    const c = read();
    expect(c.ui).toEqual({ theme: 'Dark' }); // untouched top-level key
    expect(c.mcpServers?.['my-other']).toEqual({ command: 'foo', args: ['bar'] }); // untouched server
    expect(c.mcpServers?.[ANTIGRAVITY_MCP_KEY]).toBeDefined(); // ours added
  });

  it('does NOT clobber a corrupt config (leaves it intact, returns false)', () => {
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(cfg, '{ this is not valid json', 'utf-8');
    expect(ensureAntigravityMcpConfig(cfg)).toBe(false);
    expect(readFileSync(cfg, 'utf-8')).toBe('{ this is not valid json'); // untouched
  });

  it('treats an empty file as a fresh config (writes ours)', () => {
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(cfg, '   \n', 'utf-8');
    expect(ensureAntigravityMcpConfig(cfg)).toBe(true);
    expect(read().mcpServers?.[ANTIGRAVITY_MCP_KEY]).toBeDefined();
  });
});

describe('removeAntigravityMcpConfig', () => {
  it('removes only our key, leaving other servers + keys intact', () => {
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(cfg, JSON.stringify({
      ui: { theme: 'Dark' },
      mcpServers: { 'my-other': { command: 'foo' }, [ANTIGRAVITY_MCP_KEY]: { command: 'x', args: [] } },
    }), 'utf-8');

    expect(removeAntigravityMcpConfig(cfg)).toBe(true);
    const c = read();
    expect(c.mcpServers?.[ANTIGRAVITY_MCP_KEY]).toBeUndefined();
    expect(c.mcpServers?.['my-other']).toEqual({ command: 'foo' });
    expect(c.ui).toEqual({ theme: 'Dark' });
  });

  it('no-ops (returns false) when the config or our key is absent', () => {
    expect(removeAntigravityMcpConfig(cfg)).toBe(false); // missing file
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ mcpServers: { other: {} } }), 'utf-8');
    expect(removeAntigravityMcpConfig(cfg)).toBe(false); // our key absent
  });
});

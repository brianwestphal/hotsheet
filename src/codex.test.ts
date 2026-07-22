// HS-9369 — Codex global MCP-config registration (`codex mcp add`-mediated).
import { describe, expect, it, vi } from 'vitest';

import { getChannelServerPath } from './channel-config.js';
import { CODEX_MCP_KEY, codexConfigHasEntry, ensureCodexMcpConfig } from './codex.js';

describe('codexConfigHasEntry', () => {
  const cmd = '/usr/local/bin/node';

  it('true when the section exists and carries the command (bare or quoted header)', () => {
    expect(codexConfigHasEntry(`[mcp_servers.${CODEX_MCP_KEY}]\ncommand = "${cmd}"\nargs = ["/x/channel.js"]\n`, cmd)).toBe(true);
    expect(codexConfigHasEntry(`[mcp_servers."${CODEX_MCP_KEY}"]\ncommand = "${cmd}"\n`, cmd)).toBe(true);
  });

  it('false when the section is absent or the command differs', () => {
    expect(codexConfigHasEntry('', cmd)).toBe(false);
    expect(codexConfigHasEntry('[mcp_servers.other]\ncommand = "x"\n', cmd)).toBe(false);
    expect(codexConfigHasEntry(`[mcp_servers.${CODEX_MCP_KEY}]\ncommand = "/old/node"\n`, cmd)).toBe(false);
  });

  it('scopes the command check to OUR section (a later section with the command does not count)', () => {
    const text = `[mcp_servers.${CODEX_MCP_KEY}]\ncommand = "/old/node"\n\n[mcp_servers.other]\ncommand = "${cmd}"\n`;
    expect(codexConfigHasEntry(text, cmd)).toBe(false);
  });
});

describe('ensureCodexMcpConfig', () => {
  const { command, args } = getChannelServerPath();

  it('runs `codex mcp add hotsheet-channel -- <channel command…>` when absent', () => {
    const runCodex = vi.fn();
    expect(ensureCodexMcpConfig({ runCodex, readConfig: () => '' })).toBe(true);
    expect(runCodex).toHaveBeenCalledWith(['mcp', 'add', CODEX_MCP_KEY, '--', command, ...args]);
  });

  it('is a no-op when the entry is already present with the right command', () => {
    const runCodex = vi.fn();
    const text = `[mcp_servers.${CODEX_MCP_KEY}]\ncommand = "${command}"\nargs = []\n`;
    expect(ensureCodexMcpConfig({ runCodex, readConfig: () => text })).toBe(false);
    expect(runCodex).not.toHaveBeenCalled();
  });

  it('re-adds when the entry carries a STALE command (e.g. an old install path)', () => {
    const runCodex = vi.fn();
    const text = `[mcp_servers.${CODEX_MCP_KEY}]\ncommand = "/old/path/node"\n`;
    expect(ensureCodexMcpConfig({ runCodex, readConfig: () => text })).toBe(true);
    expect(runCodex).toHaveBeenCalledTimes(1);
  });

  it('still attempts the add when the config is unreadable (precheck inconclusive)', () => {
    const runCodex = vi.fn();
    expect(ensureCodexMcpConfig({ runCodex, readConfig: () => null })).toBe(true);
  });

  it('best-effort: a failing codex invocation is swallowed (returns false)', () => {
    const runCodex = vi.fn(() => { throw new Error('codex not found'); });
    expect(ensureCodexMcpConfig({ runCodex, readConfig: () => '' })).toBe(false);
  });
});

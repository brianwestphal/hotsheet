// HS-9629 — the codex-daemon warm-pool client detector. Marking codex's
// model-B connections `warm` (and excluding them from the multi-connection
// count) hinges entirely on THIS predicate recognizing codex's MCP
// `clientInfo.name` while never mislabeling Claude Code. Both directions are
// pinned here.
import { describe, expect, it } from 'vitest';

import { isWarmPoolClient } from './channelWarmClient.js';

describe('isWarmPoolClient (HS-9629)', () => {
  it('matches codex client names (case-insensitive, substring)', () => {
    expect(isWarmPoolClient('codex')).toBe(true);
    expect(isWarmPoolClient('Codex')).toBe(true);
    expect(isWarmPoolClient('CODEX')).toBe(true);
    // Version-suffixed / renamed variants still match the substring.
    expect(isWarmPoolClient('codex-cli')).toBe(true);
    expect(isWarmPoolClient('codex-mcp-client')).toBe(true);
    expect(isWarmPoolClient('openai-codex')).toBe(true);
  });

  it('does NOT match Claude Code — the connection type the warning is FOR', () => {
    expect(isWarmPoolClient('claude-code')).toBe(false);
    expect(isWarmPoolClient('claude')).toBe(false);
    expect(isWarmPoolClient('Claude Code')).toBe(false);
  });

  it('does NOT match other / unknown clients (treated as normal mains)', () => {
    expect(isWarmPoolClient('opencode')).toBe(false);
    expect(isWarmPoolClient('mcp-inspector')).toBe(false);
    expect(isWarmPoolClient('some-other-agent')).toBe(false);
  });

  it('treats empty / undefined / null as not-warm (a normal MAIN connection)', () => {
    expect(isWarmPoolClient('')).toBe(false);
    expect(isWarmPoolClient(undefined)).toBe(false);
    expect(isWarmPoolClient(null)).toBe(false);
  });
});

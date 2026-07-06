// HS-9338 — client helpers for the Agent-backend picker.
import { describe, expect, it } from 'vitest';

import { agentBackendSelectValue, deriveDefaultTransport, TRANSPORT_LABEL } from './agentBackend.js';

describe('deriveDefaultTransport (HS-9338, mirror of the server capability table)', () => {
  it('maps antigravity → mcp-hooks, opencode → acp, everything else → claude-channel', () => {
    expect(deriveDefaultTransport('antigravity')).toBe('mcp-hooks');
    expect(deriveDefaultTransport('Antigravity')).toBe('mcp-hooks'); // case-insensitive
    expect(deriveDefaultTransport('opencode')).toBe('acp');
    expect(deriveDefaultTransport('claude')).toBe('claude-channel');
    expect(deriveDefaultTransport('auto')).toBe('claude-channel');
    expect(deriveDefaultTransport('cursor')).toBe('claude-channel'); // editor tool
    expect(deriveDefaultTransport(undefined)).toBe('claude-channel');
  });
});

describe('agentBackendSelectValue (HS-9338)', () => {
  it('maps a stored agent_backend to the select value (auto | transport)', () => {
    expect(agentBackendSelectValue(undefined)).toBe('auto');
    expect(agentBackendSelectValue('auto')).toBe('auto');
    expect(agentBackendSelectValue('')).toBe('auto');
    expect(agentBackendSelectValue('claude-channel')).toBe('claude-channel');
    expect(agentBackendSelectValue('mcp-hooks')).toBe('mcp-hooks');
    expect(agentBackendSelectValue('acp')).toBe('acp');
    // an advanced stored form collapses to its transport for the select
    expect(agentBackendSelectValue('acp:goose acp')).toBe('acp');
  });
});

describe('TRANSPORT_LABEL', () => {
  it('has a human label for every transport', () => {
    expect(TRANSPORT_LABEL['claude-channel']).toBeTruthy();
    expect(TRANSPORT_LABEL['mcp-hooks']).toBeTruthy();
    expect(TRANSPORT_LABEL.acp).toBeTruthy();
  });
});

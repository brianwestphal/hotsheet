// HS-9302 — the pure remote-origin resolution helpers (docs/112 §112.4).
import { describe, expect, it } from 'vitest';

import { apiBaseOrigin, httpOriginToWs, isLocalOnlyApiPath } from './remoteOrigin.js';

const REMOTE = 'https://remote.example:4174';

describe('apiBaseOrigin', () => {
  it('returns "" for a LOCAL project (no origin) — same-origin, unchanged behavior', () => {
    expect(apiBaseOrigin(undefined, '/tickets')).toBe('');
    expect(apiBaseOrigin('', '/tickets')).toBe('');
  });

  it('targets the remote origin for a data-plane path when the active project is remote', () => {
    expect(apiBaseOrigin(REMOTE, '/tickets')).toBe(REMOTE);
    expect(apiBaseOrigin(REMOTE, '/poll?v=1')).toBe(REMOTE);
    expect(apiBaseOrigin(REMOTE, '/settings')).toBe(REMOTE);
    expect(apiBaseOrigin(REMOTE, '/devices/active')).toBe(REMOTE); // active-device lease is per (remote) project
  });

  it('keeps control-plane paths LOCAL even when the active project is remote', () => {
    // The local registry, the remotes store, and machine config live on THIS machine.
    expect(apiBaseOrigin(REMOTE, '/projects')).toBe('');
    expect(apiBaseOrigin(REMOTE, '/projects/register')).toBe('');
    expect(apiBaseOrigin(REMOTE, '/remotes')).toBe('');
    expect(apiBaseOrigin(REMOTE, '/global-config')).toBe('');
    expect(apiBaseOrigin(REMOTE, '/projects?foo=1')).toBe('');
  });
});

describe('isLocalOnlyApiPath', () => {
  it('matches the control-plane prefixes (exact, subpath, and with query)', () => {
    for (const p of ['/projects', '/projects/register', '/projects/reorder', '/remotes', '/remotes/x', '/global-config', '/global-config?a=b']) {
      expect(isLocalOnlyApiPath(p)).toBe(true);
    }
  });

  it('does not match data-plane paths', () => {
    for (const p of ['/tickets', '/poll', '/settings', '/devices/active', '/projectsxyz', '/remotesque']) {
      expect(isLocalOnlyApiPath(p)).toBe(false);
    }
  });

  it('does not false-match a path that merely starts with a prefix string but not a segment', () => {
    // `/projectsettings` is NOT `/projects` or `/projects/...`
    expect(isLocalOnlyApiPath('/projectsettings')).toBe(false);
  });
});

describe('httpOriginToWs', () => {
  it('maps https→wss and http→ws, preserving host/port', () => {
    expect(httpOriginToWs('https://remote.example:4174')).toBe('wss://remote.example:4174');
    expect(httpOriginToWs('http://192.168.1.5:4174')).toBe('ws://192.168.1.5:4174');
  });
});

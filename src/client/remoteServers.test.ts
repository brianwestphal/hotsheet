// HS-9303 — the pure remotes-store merge helpers (docs/112 §112.6).
import { describe, expect, it } from 'vitest';

import type { RemotesFile } from '../api/index.js';
import { removeServer, upsertServer } from './remoteServers.js';

const A = { origin: 'https://a:4174', label: 'A', projects: [] };
const B = { origin: 'https://b:4174', label: 'B', projects: [{ secret: 's', name: 'P' }] };

describe('upsertServer', () => {
  it('adds a new server', () => {
    const out = upsertServer({ servers: [] }, A);
    expect(out.servers).toEqual([A]);
  });

  it('replaces an existing server (by origin), keeping others', () => {
    const store: RemotesFile = { servers: [A, B] };
    const out = upsertServer(store, { origin: 'https://a:4174', label: 'A renamed', projects: [] });
    expect(out.servers).toHaveLength(2);
    expect(out.servers.find(s => s.origin === 'https://a:4174')?.label).toBe('A renamed');
    expect(out.servers.find(s => s.origin === 'https://b:4174')).toEqual(B);
  });

  it('re-adding a server with no projects PRESERVES its already-enumerated projects', () => {
    const store: RemotesFile = { servers: [B] };
    // "Add server" for B again (projects: []) must not wipe B's mounted project.
    const out = upsertServer(store, { origin: 'https://b:4174', label: 'B', projects: [] });
    expect(out.servers[0].projects).toEqual([{ secret: 's', name: 'P' }]);
  });

  it('a re-add WITH projects replaces them (the enumeration path)', () => {
    const store: RemotesFile = { servers: [B] };
    const out = upsertServer(store, { origin: 'https://b:4174', label: 'B', projects: [{ secret: 's2', name: 'P2' }] });
    expect(out.servers[0].projects).toEqual([{ secret: 's2', name: 'P2' }]);
  });
});

describe('removeServer', () => {
  it('removes the server at origin, leaving the rest', () => {
    const out = removeServer({ servers: [A, B] }, 'https://a:4174');
    expect(out.servers).toEqual([B]);
  });

  it('is a no-op when the origin is absent', () => {
    const out = removeServer({ servers: [A] }, 'https://nope:4174');
    expect(out.servers).toEqual([A]);
  });
});

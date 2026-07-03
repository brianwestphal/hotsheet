// HS-9303 — the pure remotes-store merge helpers (docs/112 §112.6).
import { describe, expect, it } from 'vitest';

import type { RemotesFile } from '../api/index.js';
import { fetchRemoteProjects, removeServer, upsertServer } from './remoteServers.js';

/** A minimal fake `fetch` that returns `body` (as JSON) with `status`. */
function fakeFetch(status: number, body: unknown): typeof fetch {
  return (() => Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  })) as unknown as typeof fetch;
}

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

describe('fetchRemoteProjects (HS-9304)', () => {
  it('maps the remote /api/projects list to {name, secret} (tolerating extra fields)', async () => {
    const body = [
      { name: 'Alpha', secret: 's1', dataDir: '/x', ticketCount: 3 },
      { name: 'Beta', secret: 's2', dataDir: '/y', openCount: 1 },
    ];
    const out = await fetchRemoteProjects('https://h:4174', fakeFetch(200, body));
    expect(out).toEqual([{ name: 'Alpha', secret: 's1' }, { name: 'Beta', secret: 's2' }]);
  });

  it('throws on a non-2xx response', async () => {
    await expect(fetchRemoteProjects('https://h:4174', fakeFetch(403, ''))).rejects.toThrow(/403/);
  });

  it('throws on an unexpected shape', async () => {
    await expect(fetchRemoteProjects('https://h:4174', fakeFetch(200, { not: 'an array' }))).rejects.toThrow(/shape/i);
  });

  it('hits `<origin>/api/projects`', async () => {
    let calledUrl = '';
    const spy = ((url: string) => { calledUrl = url; return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve([]) }); }) as unknown as typeof fetch;
    await fetchRemoteProjects('https://h:4174', spy);
    expect(calledUrl).toBe('https://h:4174/api/projects');
  });
});

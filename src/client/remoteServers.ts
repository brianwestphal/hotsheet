// HS-9303 (docs/112 §112.6) — client-side mutations of the remotes store: add /
// remove a remote server (read-modify-write over `GET`/`PUT /api/remotes`). The
// merge logic is pure + tested; the network wrappers do the read-modify-write.
// Adding a server records it with NO projects yet — enumerating + mounting its
// projects is HS-9304.

import { z } from 'zod';

import { getRemotes, putRemotes, type RemoteProject, type RemoteServer, type RemotesFile } from '../api/index.js';

/** Pure — add or replace `server` (deduped by `origin`). Re-adding an existing
 *  server with no projects PRESERVES its already-enumerated projects (so the
 *  "Add" flow doesn't wipe a server the user previously mounted projects from). */
export function upsertServer(store: RemotesFile, server: RemoteServer): RemotesFile {
  const existing = store.servers.find(s => s.origin === server.origin);
  const merged: RemoteServer = existing !== undefined && server.projects.length === 0
    ? { ...server, projects: existing.projects }
    : server;
  return { servers: [...store.servers.filter(s => s.origin !== server.origin), merged] };
}

/** Pure — remove the server at `origin` (no-op when absent). */
export function removeServer(store: RemotesFile, origin: string): RemotesFile {
  return { servers: store.servers.filter(s => s.origin !== origin) };
}

/** Add a remote server to the store (no projects yet — enumeration is HS-9304). */
export async function addRemoteServer(origin: string, label: string): Promise<void> {
  const store = await getRemotes();
  await putRemotes(upsertServer(store, { origin, label, projects: [] }));
}

/** Remove a remote server (and its mounted projects) from the store. */
export async function removeRemoteServer(origin: string): Promise<void> {
  const store = await getRemotes();
  await putRemotes(removeServer(store, origin));
}

// --- HS-9304 (docs/112 §112.7) — enumerate + mount remote projects ---

// The remote server's `GET /api/projects` returns `[{name, secret, ...}]`; we only
// need name + secret. `.loose()` tolerates the count fields it also sends.
const RemoteProjectListSchema = z.array(z.object({ name: z.string(), secret: z.string() }).loose());

/**
 * Enumerate a remote server's projects via a cross-origin `GET <origin>/api/projects`
 * (the browser presents the client cert on the mTLS handshake, §97.3). Throws on a
 * non-2xx / network error / unexpected shape so the caller can surface it (a common
 * failure is the cert not being installed yet). Pure over the injected `fetch` for
 * testability.
 */
export async function fetchRemoteProjects(
  origin: string,
  fetchFn: typeof fetch = fetch,
): Promise<RemoteProject[]> {
  const res = await fetchFn(`${origin}/api/projects`);
  if (!res.ok) throw new Error(`The server responded ${String(res.status)}.`);
  const raw: unknown = await res.json();
  const parsed = RemoteProjectListSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Unexpected project-list shape from the server.');
  return parsed.data.map(p => ({ name: p.name, secret: p.secret }));
}

/** Mount the selected projects of a remote server: upsert the server with exactly
 *  those projects (read-modify-write). An empty selection removes the server's
 *  mounted projects (but keeps the server). */
export async function mountRemoteProjects(origin: string, label: string, projects: RemoteProject[]): Promise<void> {
  const store = await getRemotes();
  // Force-replace projects even when the selection is empty (bypass upsert's
  // "preserve on empty" rule, which is for the plain Add-server flow).
  const others = store.servers.filter(s => s.origin !== origin);
  await putRemotes({ servers: [...others, { origin, label, projects }] });
}

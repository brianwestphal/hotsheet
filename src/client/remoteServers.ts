// HS-9303 (docs/112 §112.6) — client-side mutations of the remotes store: add /
// remove a remote server (read-modify-write over `GET`/`PUT /api/remotes`). The
// merge logic is pure + tested; the network wrappers do the read-modify-write.
// Adding a server records it with NO projects yet — enumerating + mounting its
// projects is HS-9304.

import { getRemotes, putRemotes, type RemoteServer, type RemotesFile } from '../api/index.js';

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

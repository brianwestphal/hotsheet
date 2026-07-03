// HS-9302 (docs/112 §112.4) — remote-origin resolution for the client transport.
// A remote project's `ProjectInfo` carries an `origin` (`https://host:port`); its
// data/WS calls target that origin instead of same-origin localhost. These pure
// helpers centralize the "which base URL" decision so all four URL builders
// (api.tsx, wsSync.ts, terminalCheckout.tsx, imageProxy.tsx) agree — and so the
// control-plane vs data-plane split is defined in exactly one place.

/** Control-plane path prefixes that ALWAYS target the LOCAL server, even when the
 *  active project is remote: the local project registry, the remotes store, and
 *  machine-global config all live on THIS machine, not on the remote server.
 *  Everything else is data-plane (goes to the active remote origin when remote). */
const LOCAL_ONLY_PREFIXES = ['/projects', '/remotes', '/global-config'];

/** True when `path` (an `/api`-relative path, possibly with a query string) is a
 *  control-plane path that must stay local. */
export function isLocalOnlyApiPath(path: string): boolean {
  const p = path.split('?')[0];
  return LOCAL_ONLY_PREFIXES.some(pre => p === pre || p.startsWith(pre + '/'));
}

/**
 * The origin to prefix an `/api` path with: the remote `origin` when a remote
 * project is active AND the path is data-plane; else `''` (relative → same-origin
 * localhost, exactly as today). Returns `''` for a local project (origin absent),
 * so local behavior is byte-for-byte unchanged.
 */
export function apiBaseOrigin(activeOrigin: string | undefined, path: string): string {
  if (activeOrigin === undefined || activeOrigin === '' || isLocalOnlyApiPath(path)) return '';
  return activeOrigin;
}

/** Convert an `http(s)://host` origin to its `ws(s)://host` form for WebSocket
 *  URLs (`https:` → `wss:`, `http:` → `ws:`). */
export function httpOriginToWs(origin: string): string {
  return origin.replace(/^http/i, 'ws');
}

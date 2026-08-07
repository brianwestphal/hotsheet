// HS-9615 — the two PURE pieces of the channel launch line, split out of
// `channel-config.ts` so they are client-safe.
//
// `channel-config.ts` imports `fs` / `path` / `url` and (transitively) the whole server
// graph. `slugifyDataDir` and `claudeWithChannelCommand` need none of it: they are
// string transforms over a `--data-dir` path. Keeping them in that module was harmless
// until `aiTools/plugins/claude.ts` needed the launch line for its worker capability
// (HS-9601) — and `aiTools/**` is client-reachable (`settingsDialog.tsx` →
// `aiTools/registry.ts`), so that one import pulled `fs`, `path`, `child_process`, acp
// and db into the browser bundle and `npm run build:client` failed with 132 unresolved
// node builtins. See the client-safety note at the top of `aiTools/types.ts`.
//
// So: nothing in this file may import a node builtin. `basename` is spelled out below
// for that reason.

/**
 * HS-8349 — derive a stable per-project slug from the channel server's `--data-dir`.
 * The basename of the project root (parent of `.hotsheet/`) is lowercased and
 * non-alphanumeric runs collapse to a single `-`. Leading / trailing `-` are trimmed.
 * An empty result falls back to `project` so the slug is always non-empty.
 */
export function slugifyDataDir(dataDir: string): string {
  const root = dataDir.replace(/[\\/]\.hotsheet[\\/]?$/, '');
  // Stands in for `path.basename` — see the file header. Splitting on BOTH separators
  // matches the `[\\/]` the suffix strip above already uses, so a Windows path behaves
  // the same here as it did under `path.win32.basename`.
  const base = root.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '';
  const slug = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug !== '' ? slug : 'project';
}

/**
 * HS-8349 — the development-channel launch line for a project. The MCP server name is
 * per-project (`hotsheet-channel-<slug>`), so this mirrors `slugifyDataDir`.
 *
 * HS-9492 — lives beside the slug it depends on rather than in
 * `terminals/resolveCommand.ts` because it has several unrelated consumers (the
 * terminal's Claude command capability, the worker-pool launch line, and
 * `aiTools/plugins/claude.ts`), and none of them should import the others.
 */
export function claudeWithChannelCommand(dataDir: string): string {
  return `claude --dangerously-load-development-channels server:hotsheet-channel-${slugifyDataDir(dataDir)}`;
}

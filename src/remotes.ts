// HS-9302 (docs/112 §112.3) — the machine-global remote-servers store,
// `~/.hotsheet/remotes.json`. A remote Hot Sheet server (and the projects mounted
// from it) isn't tied to any one local project's `.hotsheet/`, so it lives at the
// machine level alongside `config.json`. Mirrors `src/global-config.ts`'s fs
// read/write; the shape is the SSOT `RemotesFileSchema` in `routes/validation.ts`,
// shared with the client typed caller.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

import { globalHotsheetDir } from './global-dir.js';
import { type RemotesFile, RemotesFileSchema } from './routes/validation.js';

export type { RemoteProject, RemoteServer, RemotesFile } from './routes/validation.js';

function getRemotesPath(): string {
  return join(globalHotsheetDir(), 'remotes.json');
}

/** Read `~/.hotsheet/remotes.json`, or `{ servers: [] }` when absent/invalid. */
export function readRemotes(): RemotesFile {
  const path = getRemotesPath();
  if (!existsSync(path)) return { servers: [] };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const result = RemotesFileSchema.safeParse(raw);
    if (!result.success) {
      console.warn(`[remotes] Invalid remotes.json: ${result.error.message}`);
      return { servers: [] };
    }
    return result.data;
  } catch (err: unknown) {
    // Surface non-ENOENT read errors (permission denied, partial-write JSON) —
    // mirrors global-config's HS-8087 behavior so a corrupt file is noticed, not
    // silently reset.
    if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[remotes] Failed to read remotes.json: ${err.message}`);
    }
    return { servers: [] };
  }
}

/** Replace the entire remotes store (validated + normalized). Returns what was
 *  written. Callers pass the full desired state; add/remove is a read-modify-write
 *  at the call site (the store is small). */
export function writeRemotes(next: RemotesFile): RemotesFile {
  const parsed = RemotesFileSchema.parse(next); // throws on a bad shape — caller's bug
  const dir = globalHotsheetDir();
  mkdirSync(dir, { recursive: true });
  writeFileSync(getRemotesPath(), JSON.stringify(parsed, null, 2) + '\n', 'utf-8');
  return parsed;
}

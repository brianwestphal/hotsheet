// HS-9340 — the real filesystem adapter for the ACP client's delegated `fs/*` ops.
//
// OpenCode delegates every file read/write to the ACP client (docs/114 §114.12); this
// performs them, CONFINED to the project directory. The agent supplies absolute paths, so
// a write/read outside the project (a bug, or an agent reaching for a system file) is
// rejected — the delegation can't become a vector for touching files outside the workspace
// the user opened. (OpenCode's own permission prompt still gates the edit BEFORE this runs.)
//
// Separated from `acpDrive.ts` so the confinement logic is unit-testable against a temp
// dir without spawning an agent.

import { realpathSync } from 'fs';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path';

import type { AcpFsHandlers } from './acpClient.js';

/** True when `target` resolves to a path inside (or equal to) `root`. */
export function isInsideDir(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Resolve `p` to an absolute path with symlinks normalized — realpath the deepest
 * EXISTING ancestor (a write target may not exist yet) and re-append the non-existent
 * tail. So a path under a symlinked root (macOS `/tmp`→`/private/tmp`) compares equal to
 * a realpath'd root regardless of which form the caller passed.
 */
export function normalizePath(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return resolve(p); // reached the fs root; nothing existed
      tail.push(basename(cur));
      cur = parent;
    }
  }
}

/**
 * Build fs handlers confined to `projectDir`. Reads + writes outside the project reject
 * (→ the agent gets a JSON-RPC error, never a hang). Symlinks in the root are resolved
 * once (macOS `/var`→`/private/var`) so the agent's already-resolved absolute paths
 * compare correctly.
 */
export function makeProjectFsHandlers(projectDir: string): AcpFsHandlers {
  const root = normalizePath(projectDir);

  const confine = (p: string): string => {
    const abs = normalizePath(p);
    if (!isInsideDir(root, abs)) throw new Error(`path outside project: ${abs}`);
    return abs;
  };

  return {
    // `async` so a `confine()` rejection is a rejected promise, never a synchronous throw
    // (a sync throw would escape the client's `.then` in `acpClient.route`).
    readTextFile: async (path) => readFile(confine(path), 'utf-8'),
    writeTextFile: async (path, content) => {
      const abs = confine(path);
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf-8');
    },
  };
}

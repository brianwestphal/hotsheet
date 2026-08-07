/**
 * HS-9615 — the client bundle must not reach a node builtin.
 *
 * `scripts/build-client.mjs` bundles `src/client/app.tsx` (and `pair.tsx`) for the
 * BROWSER, so a single import edge from client-reachable code into a module that
 * imports `fs` / `path` / `child_process` fails the build outright — and takes the whole
 * server graph with it, because those modules import each other. `aiTools/types.ts`
 * documents the constraint ("this module and everything it pulls in must stay
 * client-safe"), but nothing enforced it.
 *
 * That is how HS-9601 broke `npm run tauri:dev`: it gave `claudePlugin` a worker launch
 * command sourced from `channel-config.js`, and `aiTools/registry.ts` is reached from
 * `client/settingsDialog.tsx`. One line, 132 unresolved-builtin errors, and none of
 * `npm test` / `npm run lint` / `tsc --noEmit` noticed — the failure only appears when
 * someone runs a client build. This test moves it into the unit suite.
 *
 * It walks the static import graph itself rather than shelling out to esbuild: it is
 * fast, needs no build artifacts, and the failure message can name the exact chain from
 * the entry point to the offending import, which is the part that takes the longest to
 * work out by hand.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, relative, resolve } from 'path';
import { describe, expect, it } from 'vitest';

const repoRoot = process.cwd();

/** Entry points `scripts/build-client.mjs` bundles for the browser. */
const CLIENT_ENTRIES = ['src/client/app.tsx', 'src/client/pair.tsx'];

/**
 * Static + dynamic imports and re-exports. esbuild follows all three, so the guard has
 * to as well — a `await import('child_process')` is bundled exactly like a top-level
 * one, which is why `open-in-file-manager.ts` appeared in the HS-9615 error list.
 */
const IMPORT_RE = /(?:^|[\s;}])(?:import|export)\s+(?:[^'"()]*?\sfrom\s*)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/** `import type` / `export type` erase at compile time — esbuild never resolves them. */
const TYPE_ONLY_RE = /(?:^|[\s;}])(?:import|export)\s+type\s/;

function isRelative(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../');
}

function isNodeBuiltin(spec: string): boolean {
  if (spec.startsWith('node:')) return true;
  // The bare builtins this repo actually imports. A bare specifier that is NOT one of
  // these is an npm package, which the browser bundle may legitimately contain.
  return [
    'assert', 'buffer', 'child_process', 'crypto', 'dns', 'events', 'fs', 'fs/promises',
    'http', 'http2', 'https', 'module', 'net', 'os', 'path', 'perf_hooks', 'process',
    'readline', 'stream', 'string_decoder', 'timers', 'tls', 'tty', 'url', 'util',
    'v8', 'worker_threads', 'zlib',
  ].includes(spec);
}

/** Resolve a TS-ESM specifier (`./foo.js`) to the file on disk (`./foo.ts` / `.tsx`). */
function resolveLocal(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec).replace(/\.js$/, '');
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

interface Violation {
  builtin: string;
  chain: string[];
}

/** BFS from an entry point, stopping at the first builtin reached (shortest chain). */
function findBuiltinImport(entry: string): Violation | null {
  const start = resolve(repoRoot, entry);
  const prev = new Map<string, string | null>([[start, null]]);
  const queue = [start];

  while (queue.length > 0) {
    const file = queue.shift()!;
    const source = readFileSync(file, 'utf8');
    const specs = new Set<string>();

    for (const line of source.split('\n')) {
      if (TYPE_ONLY_RE.test(line)) continue;
      for (const m of line.matchAll(IMPORT_RE)) specs.add(m[1]);
      for (const m of line.matchAll(DYNAMIC_IMPORT_RE)) specs.add(m[1]);
    }

    for (const spec of specs) {
      if (isNodeBuiltin(spec)) {
        const chain: string[] = [];
        for (let c: string | null | undefined = file; c !== null && c !== undefined; c = prev.get(c)) {
          chain.unshift(relative(repoRoot, c));
        }
        return { builtin: spec, chain };
      }
      if (!isRelative(spec)) continue;
      const next = resolveLocal(file, spec);
      // Unresolvable relative specifiers are .scss / assets — not our concern here.
      if (next === null || prev.has(next)) continue;
      prev.set(next, file);
      queue.push(next);
    }
  }
  return null;
}

describe('client bundle purity (HS-9615)', () => {
  for (const entry of CLIENT_ENTRIES) {
    it(`${entry} reaches no node builtin`, () => {
      const violation = findBuiltinImport(entry);
      const detail = violation === null ? '' :
        `\n\n"${violation.builtin}" is reachable from the browser bundle:\n  ` +
        violation.chain.join('\n  -> ') +
        `\n\nThe last two entries are the edge to fix. Client-reachable code must import` +
        ` the client-safe half of a module (e.g. channelSlug.js, not channel-config.js).`;
      expect(violation, `${entry} pulls a node builtin into the browser bundle.${detail}`).toBeNull();
    });
  }

  it('the walker actually finds a violation when one exists', () => {
    // Guards the guard: a regex that quietly stops matching would make every assertion
    // above vacuous. `src/channel-config.ts` imports `fs` on its first line.
    const violation = findBuiltinImport('src/channel-config.ts');
    expect(violation).not.toBeNull();
    expect(violation!.chain[0]).toBe('src/channel-config.ts');
  });

  it('the AI-tool registry stays client-safe', () => {
    // The contract `aiTools/types.ts` states in prose, asserted directly. It is a
    // stricter guard than the entry-point walks above (which would also go green if
    // someone simply stopped importing the registry from client code) and it names the
    // right module when the next tool plugin reaches for a server helper.
    expect(findBuiltinImport('src/aiTools/registry.ts')).toBeNull();
  });

  it('follows a multi-hop chain, not just direct imports', () => {
    // HS-9601's edge was two hops from the client entry, so a walker that only checked
    // direct imports would have missed it. Proven on a fixture rather than a real module
    // pair, which would silently stop testing this the day either file changed.
    const dir = mkdtempSync(join(tmpdir(), 'hs-purity-'));
    writeFileSync(join(dir, 'entry.ts'), "import { a } from './mid.js';\nexport const b = a;\n");
    writeFileSync(join(dir, 'mid.ts'), "import { readFileSync } from 'fs';\nexport const a = readFileSync;\n");

    const violation = findBuiltinImport(join(dir, 'entry.ts'));
    expect(violation?.builtin).toBe('fs');
    expect(violation?.chain).toHaveLength(2);
    expect(violation?.chain[1]).toMatch(/mid\.ts$/);

    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores type-only imports, which erase before bundling', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hs-purity-'));
    writeFileSync(join(dir, 'entry.ts'), "import type { Stats } from 'fs';\nexport type S = Stats;\n");

    expect(findBuiltinImport(join(dir, 'entry.ts'))).toBeNull();

    rmSync(dir, { recursive: true, force: true });
  });
});

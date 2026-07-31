/**
 * HS-9523 — the `npm run lint` gate must actually LOOK at the code the config
 * writes rules for.
 *
 * ## The bug this exists to catch
 *
 * CLAUDE.md states the quality gate as *"`npx tsc --noEmit` and `npm run lint`
 * must both pass with zero errors"*. That sentence is only as strong as the
 * script's argument list, and the script was `eslint src/` — so `plugins/` was
 * never linted at all, despite `eslint.config.mjs` defining rules that match it.
 *
 * The cost was not hypothetical. `plugins/github-issues/src/index.ts` carried
 * **10** `await res.json() as Y` violations of the HS-8567 wire-boundary rule —
 * in the one module in the tree that talks to a third-party REST API, which is
 * exactly where that rule earns its keep. The gate had been green the whole time.
 *
 * This compounds HS-9518: with `plugins/` outside the gate AND the `src/`
 * selectors switched off by a trailing config block, `no-restricted-syntax` was
 * effectively unenforced repo-wide while reporting success.
 *
 * ## Why this test and not a lint rule
 *
 * No lint rule can catch it, because the failure is that lint never runs on the
 * file. It is a property of the *script*, so it has to be asserted against the
 * script — by reading the `lint` command out of `package.json` and comparing its
 * paths against the directories the config claims to govern.
 *
 * ## Adding a deliberately-ungated directory
 *
 * Add it to `KNOWN_UNGATED` with a reason. That keeps the exemption a visible,
 * reviewed decision instead of an accident of argument order — the whole point.
 */
import { readdirSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('..', import.meta.url);
const readRoot = (rel) => readFileSync(fileURLToPath(new URL(rel, ROOT)), 'utf8');

/**
 * Top-level directories that hold lintable source and are not ignored.
 *
 * Two earlier versions of this were too weak to catch the actual bug, which is
 * worth recording because both looked reasonable:
 *
 * 1. Regexing `files: [...]` out of the config source matched prose inside
 *    comments and reported directories named "✓ …" and ", ".
 * 2. Reading `files:` off the *resolved* config fixed that but still missed
 *    `plugins/` — the very directory this ticket is about. Most rules here come
 *    from the BASE config, which has no `files:` key at all because it applies
 *    to everything. A directory can therefore be fully governed while appearing
 *    in no `files:` glob anywhere.
 *
 * So the question is not "what does the config name?" but "what code would ESLint
 * lint if you pointed it at the repo?" — i.e. every top-level directory holding
 * lintable files, minus the ones `ignores` excludes.
 */
async function lintableDirectories() {
  const { default: config } = await import(new URL('eslint.config.mjs', ROOT).href);
  const ignoredTops = new Set(
    config
      .flatMap((block) => block.ignores ?? [])
      .filter((glob) => typeof glob === 'string')
      .map((glob) => glob.split('/')[0])
      .filter((top) => !top.includes('*')),
  );

  const dirs = new Set();
  for (const entry of readdirSync(fileURLToPath(ROOT), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || ignoredTops.has(entry.name)) continue;
    if (holdsLintableSource(fileURLToPath(new URL(`${entry.name}/`, ROOT)))) dirs.add(entry.name);
  }
  return dirs;
}

/** Does this tree contain a file ESLint would parse? Depth-limited — we only need
 *  to know whether the directory is in scope at all, not to enumerate it. */
function holdsLintableSource(dir, depth = 0) {
  if (depth > 3) return false;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (entry.isFile() && /\.(ts|tsx|mjs)$/.test(entry.name)) return true;
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
      if (holdsLintableSource(`${dir}${entry.name}/`, depth + 1)) return true;
    }
  }
  return false;
}

/** Paths passed to `eslint` by the `lint` script. */
function lintScriptPaths() {
  const pkg = JSON.parse(readRoot('package.json'));
  const script = pkg.scripts.lint;
  return script
    .replace(/^eslint\s+/, '')
    .split(/\s+/)
    .filter((arg) => arg !== '' && !arg.startsWith('-'))
    .map((arg) => arg.replace(/\/$/, ''));
}

/** Directories the config governs but the gate deliberately does not run on. */
/** Directories the config governs but the gate deliberately does not run on.
 *
 *  Empty since HS-9533: `e2e/` was the last exemption and is now gated. Adding an
 *  entry here is a reviewed decision, not an accident of argument order — which
 *  is the whole reason this map exists rather than a silent omission. */
const KNOWN_UNGATED = new Map();

describe('npm run lint scope (HS-9523)', () => {
  it('covers every non-ignored directory that holds lintable source', async () => {
    const gated = lintScriptPaths();
    const missing = [...(await lintableDirectories())]
      .filter((dir) => !gated.includes(dir))
      .filter((dir) => !KNOWN_UNGATED.has(dir));

    expect(
      missing,
      `These directories have rules in eslint.config.mjs but npm run lint never looks at them: ` +
        `${missing.join(', ')}. Either add them to the "lint" script in package.json, or add ` +
        `them to KNOWN_UNGATED in this file with the reason.`,
    ).toEqual([]);
  });

  it('gates plugins/ — the directory whose omission hid 10 HS-8567 violations', () => {
    // Named explicitly rather than left to the generic check above: this is the
    // regression, and a future edit to `configuredDirectories()` must not be able
    // to quietly stop asserting it.
    expect(lintScriptPaths()).toContain('plugins');
  });

  it('keeps every ungated directory accounted for with a stated reason', () => {
    for (const [dir, reason] of KNOWN_UNGATED) {
      expect(typeof reason === 'string' && reason.length > 20, `${dir} needs a real reason`).toBe(true);
    }
  });

  it('does not silently drop src/ from the gate', () => {
    expect(lintScriptPaths()).toContain('src');
  });
});

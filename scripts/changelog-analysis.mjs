#!/usr/bin/env node
/**
 * Deterministic git analysis for a technical changelog (see the
 * `technical-changelog` skill). Grounds the report in the *actual* diff, not
 * commit prose: it finds the base tag, buckets the line delta by area
 * (product vs docs vs scaffolding vs generated assets), classifies files
 * added/modified/removed, and surfaces the concrete public-surface deltas
 * (HTTP routes, CLI flags, dependencies, channel-protocol version, new
 * requirements docs) plus "is this genuinely new?" probes.
 *
 *   node scripts/changelog-analysis.mjs [--base <tag>] [--next <version>]
 *
 * --base   Override the auto-detected base tag (default: the most recent
 *          production release tag reachable from HEAD, pre-releases excluded).
 * --next   The next planned release number (HEAD is unreleased, so this can't
 *          be read from package.json). Only used to suggest the output path.
 *
 * Prints a human-readable report to stdout. Writes nothing — the skill reads
 * this, then reads the real per-file diffs, then authors the document.
 */
import { execFileSync } from 'node:child_process';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
function gitOk(args) {
  try {
    return git(args).trim();
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--base') out.base = argv[++i];
    else if (argv[i] === '--next') out.next = argv[++i];
    else if (argv[i] === '--head') out.head = argv[++i];
  }
  return out;
}

/** Semver-ish compare for tags like `v1.2.3` (pre-releases sort lower). */
function cmpTag(a, b) {
  const norm = (t) => t.replace(/^v/, '');
  const [av, ap = '~'] = norm(a).split('-');
  const [bv, bp = '~'] = norm(b).split('-');
  const ap2 = av.split('.').map(Number);
  const bp2 = bv.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((ap2[i] || 0) !== (bp2[i] || 0)) return (ap2[i] || 0) - (bp2[i] || 0);
  }
  // no pre-release ('~') outranks a pre-release ('-beta') at the same version
  return ap < bp ? -1 : ap > bp ? 1 : 0;
}

/**
 * The most recent *production* release tag that is an ancestor of HEAD.
 * Production = a `vX.Y.Z` tag with no pre-release suffix (`-beta`, `-rc`, …).
 */
function latestProductionTag(head) {
  const tags = git(['tag', '--list', 'v*'])
    .split('\n')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t)) // strict production semver, no suffix
    .filter((t) => gitOk(['merge-base', '--is-ancestor', t, head]) !== null);
  tags.sort(cmpTag);
  return tags.length > 0 ? tags[tags.length - 1] : null;
}

/** A colocated unit/e2e test file (Hot Sheet keeps `*.test.ts` next to source). */
function isTest(path) {
  return /\.(test|spec)\.(ts|tsx|mts)$/.test(path);
}

/**
 * Classify a changed path into a reporting area + whether it's product code.
 * Order matters: the test check runs first (tests live *under* `src/`), and the
 * more specific `src/*` buckets precede the catch-all `src/`.
 */
function classify(path) {
  if (isTest(path)) return { area: 'tests (unit + e2e)', product: true };
  if (/^src-tauri\//.test(path)) return { area: 'src-tauri (Rust/Tauri)', product: true };
  if (/^src\/client\//.test(path)) return { area: 'src/client', product: true };
  if (/^src\/routes\//.test(path)) return { area: 'src/routes (HTTP API + pages)', product: true };
  if (/^src\/api\//.test(path)) return { area: 'src/api (typed API layer)', product: true };
  if (/^src\/db\//.test(path)) return { area: 'src/db', product: true };
  if (/^src\//.test(path)) return { area: 'src (server, other)', product: true };
  if (/^plugins\//.test(path)) return { area: 'plugins', product: true };
  if (/^e2e\//.test(path)) return { area: 'e2e (Playwright)', product: true };
  if (/^scripts\//.test(path)) return { area: 'scripts (build/dev)', product: true };
  if (/^assets\//.test(path)) return { area: 'assets (generated)', product: false };
  if (/^docs\//.test(path)) return { area: 'docs', product: false };
  if (/^\.(claude|agents|hotsheet|cursor)\//.test(path)) return { area: 'agent/skill scaffolding', product: false };
  if (/^\.github\//.test(path)) return { area: 'CI', product: false };
  return { area: 'other (README/config)', product: false };
}

function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function padL(s, n) {
  s = String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const head = args.head ?? 'HEAD';
  const base = args.base ?? latestProductionTag(head);

  if (base === null) {
    console.error(
      'No production release tag (vX.Y.Z) found as an ancestor of HEAD.\n' +
        'Pass one explicitly with --base <tag>.',
    );
    process.exit(1);
  }

  const range = `${base}..${head}`;
  const baseInfo = git(['log', '-1', '--format=%h %ci %s', base]).trim();
  const headInfo = git(['log', '-1', `--format=%h %ci %s`, head]).trim();
  const commitCount = git(['rev-list', '--count', range]).trim();

  // All production tags, to warn if a newer one exists that isn't the base.
  const allProd = git(['tag', '--list', 'v*'])
    .split('\n')
    .map((t) => t.trim())
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .sort(cmpTag);
  const newestProd = allProd[allProd.length - 1];

  // numstat by area (--no-renames so a rename reads as delete+add and classifies cleanly)
  const numstat = git(['diff', '--numstat', '--no-renames', range])
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [add, del, ...rest] = l.split('\t');
      return { add: Number(add) || 0, del: Number(del) || 0, path: rest.join('\t') };
    });

  const areas = new Map();
  let prodAdd = 0;
  let prodDel = 0;
  let totAdd = 0;
  let totDel = 0;
  for (const { add, del, path } of numstat) {
    const { area, product } = classify(path);
    const a = areas.get(area) ?? { files: 0, add: 0, del: 0, product };
    a.files++;
    a.add += add;
    a.del += del;
    areas.set(area, a);
    totAdd += add;
    totDel += del;
    if (product) {
      prodAdd += add;
      prodDel += del;
    }
  }

  // A/M/D classification
  const status = git(['diff', '--name-status', '--no-renames', range])
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [st, ...rest] = l.split('\t');
      return { st: st[0], path: rest.join('\t') };
    });
  const added = status.filter((s) => s.st === 'A').map((s) => s.path);
  const removed = status.filter((s) => s.st === 'D').map((s) => s.path);

  // New product source files (candidate "genuinely new subsystems"). Excludes
  // tests — a new test file is not a new subsystem.
  const newProduct = added.filter((p) => classify(p).product && !isTest(p) && /\.(ts|tsx|mts|rs|mjs|js|scss)$/.test(p));

  // New requirements docs (docs/N-area.md) — a strong "new functional area" signal
  // in this repo (see CLAUDE.md § Requirements Documentation).
  const newReqDocs = added.filter((p) => /^docs\/\d+[-.].+\.md$/.test(p));

  // HTTP route surface delta — new/removed endpoint registrations across
  // src/routes/**. Hono routes look like `.get('/path', …)` / `.post('/x', …)`.
  // Require the first string arg to start with `/` so Hono *context* accessors
  // (`c.get('dataDir')`, `c.get('clientAuthenticated')`) don't read as routes.
  const routeRe = /\.(get|post|put|patch|delete|all)\(\s*[`'"]\//;
  let routeDelta = null;
  {
    const addedRoutes = new Set();
    const removedRoutes = new Set();
    // Walk the unified diff file-by-file so we can skip *.test.ts — their mock
    // Hono apps register throwaway routes (git pathspec globbing is unreliable
    // for flat test files, so filter here on the `+++ b/<path>` header).
    let inTestFile = false;
    for (const l of git(['diff', range, '--', 'src/routes/']).split('\n')) {
      const hdr = l.match(/^\+\+\+ b\/(.+)$/);
      if (hdr) {
        inTestFile = isTest(hdr[1]);
        continue;
      }
      if (inTestFile || !routeRe.test(l)) continue;
      const body = l.slice(1).trim();
      if (/^\+/.test(l) && !/^\+{3}/.test(l)) addedRoutes.add(body);
      else if (/^-/.test(l) && !/^-{3}/.test(l)) removedRoutes.add(body);
    }
    const net = [...addedRoutes].filter((r) => !removedRoutes.has(r));
    const gone = [...removedRoutes].filter((r) => !addedRoutes.has(r));
    if (net.length || gone.length) routeDelta = { net, gone };
  }

  // New/removed CLI flags (src/cli.ts), if present.
  let flagDelta = null;
  if (gitOk(['cat-file', '-e', `${head}:src/cli.ts`]) !== null) {
    const added2 = new Set();
    const removed2 = new Set();
    for (const l of git(['diff', range, '--', 'src/cli.ts']).split('\n')) {
      const m = [...l.matchAll(/--[a-z][a-z-]+/g)].map((x) => x[0]);
      if (/^\+/.test(l) && !/^\+{3}/.test(l)) m.forEach((f) => added2.add(f));
      if (/^-/.test(l) && !/^-{3}/.test(l)) m.forEach((f) => removed2.add(f));
    }
    const net = [...added2].filter((f) => !removed2.has(f));
    const gone = [...removed2].filter((f) => !added2.has(f));
    flagDelta = { net, gone };
  }

  // Channel-protocol version bump (CHANNEL_VERSION / EXPECTED_CHANNEL_VERSION).
  // A bump means the channel HTTP/MCP surface changed (CLAUDE.md § CHANNEL_VERSION).
  let channelDelta = null;
  {
    const readVer = (ref, file, sym) => {
      const src = gitOk(['show', `${ref}:${file}`]);
      if (src === null) return null;
      const m = src.match(new RegExp(`${sym}\\s*=\\s*(\\d+)`));
      return m ? m[1] : null;
    };
    const b = readVer(base, 'src/channel.ts', 'CHANNEL_VERSION');
    const h = readVer(head, 'src/channel.ts', 'CHANNEL_VERSION');
    if (b !== h) channelDelta = { from: b ?? '(none)', to: h ?? '(none)' };
  }

  // Dependency changes (package.json dependencies + devDependencies).
  let depDelta = null;
  if (gitOk(['cat-file', '-e', `${head}:package.json`]) !== null) {
    const readDeps = (ref) => {
      try {
        const pj = JSON.parse(git(['show', `${ref}:package.json`]));
        return { ...(pj.dependencies ?? {}), ...(pj.devDependencies ?? {}) };
      } catch {
        return {};
      }
    };
    const b = readDeps(base);
    const h = readDeps(head);
    const changed = [];
    for (const k of new Set([...Object.keys(b), ...Object.keys(h)])) {
      if (b[k] !== h[k]) changed.push(`${k}: ${b[k] ?? '(none)'} → ${h[k] ?? '(removed)'}`);
    }
    depDelta = changed;
  }

  // ---- print ----
  const L = [];
  L.push('# Technical Changelog Analysis');
  L.push('');
  L.push(`Base tag (auto):   ${base}   [${baseInfo}]`);
  L.push(`Head:              ${head}   [${headInfo}]`);
  L.push(`Range:             ${range}   (${commitCount} commits)`);
  L.push(`Next version:      ${args.next ?? '(NOT PROVIDED — the skill must ask the user)'}`);
  if (args.next) L.push(`Suggested output:  docs/technical-changelog/${base}-v${String(args.next).replace(/^v/, '')}.md`);
  if (newestProd && newestProd !== base) {
    L.push('');
    L.push(`⚠️  A newer production tag exists (${newestProd}) but is not the base — confirm ${base} is intended.`);
  }
  L.push('');
  L.push('## Line delta by area  (raw total is misleading — split product vs not)');
  L.push('');
  L.push(`  ${pad('area', 32)} ${padL('files', 6)} ${padL('+add', 8)} ${padL('-del', 8)}  product`);
  const sorted = [...areas.entries()].sort((a, b) => b[1].add - a[1].add);
  for (const [area, a] of sorted) {
    L.push(`  ${pad(area, 32)} ${padL(a.files, 6)} ${padL('+' + a.add, 8)} ${padL('-' + a.del, 8)}  ${a.product ? '✅' : '—'}`);
  }
  L.push('');
  L.push(`  TOTAL (raw):        +${totAdd} / -${totDel}   across ${numstat.length} files`);
  L.push(`  PRODUCT CODE ONLY:  +${prodAdd} / -${prodDel}   (src + src-tauri + plugins + e2e + tests + scripts)`);
  L.push(`  → In the report, lead with product-only; label docs/scaffolding separately.`);
  L.push('');
  L.push(`## Files: ${added.length} added, ${removed.length} removed, ${status.length - added.length - removed.length} modified`);
  L.push('');
  L.push('New product source files (candidate NEW subsystems — verify absent at base):');
  if (newProduct.length === 0) L.push('  (none)');
  for (const p of newProduct) L.push(`  A  ${p}`);
  if (newReqDocs.length > 0) {
    L.push('');
    L.push('New requirements docs (docs/N-*.md — strong "new functional area" signal):');
    for (const p of newReqDocs) L.push(`  A  ${p}`);
  }
  if (removed.length > 0) {
    L.push('');
    L.push('Removed files:');
    for (const p of removed) L.push(`  D  ${p}`);
  }
  L.push('');
  L.push('## HTTP route surface delta (src/routes/**)');
  if (routeDelta) {
    L.push('  added:');
    if (routeDelta.net.length === 0) L.push('    (none)');
    for (const r of routeDelta.net) L.push(`    + ${r}`);
    if (routeDelta.gone.length > 0) {
      L.push('  removed:');
      for (const r of routeDelta.gone) L.push(`    - ${r}`);
    }
  } else {
    L.push('  (no endpoint registrations added/removed detected)');
  }
  L.push('');
  L.push('## CLI flag delta (src/cli.ts)');
  if (flagDelta) {
    L.push(`  added: ${flagDelta.net.length ? flagDelta.net.join(', ') : '(none)'}`);
    L.push(`  removed: ${flagDelta.gone.length ? flagDelta.gone.join(', ') : '(none)'}`);
  } else {
    L.push('  (src/cli.ts not found)');
  }
  L.push('');
  L.push('## Channel-protocol version (src/channel.ts CHANNEL_VERSION)');
  L.push(channelDelta ? `  BUMPED ${channelDelta.from} → ${channelDelta.to}  (channel HTTP/MCP surface changed)` : '  (unchanged)');
  L.push('');
  L.push('## Dependency changes (package.json)');
  if (depDelta && depDelta.length > 0) for (const d of depDelta) L.push(`  ${d}`);
  else L.push('  (none)');
  L.push('');
  L.push('## Next steps for the author (do NOT stop here)');
  L.push('  1. For each area above, READ THE REAL DIFF: `git diff ' + range + ' -- <path>`.');
  L.push('  2. Verify each "new" claim against the base tree, e.g.');
  L.push('       `git cat-file -e ' + base + ':<file>`  (absent → genuinely new)');
  L.push('       `git show ' + base + ':<file> | grep -c <symbol>`  (0 → added in range)');
  L.push('  3. Note what already shipped at ' + base + ' (baseline, NOT a change).');
  L.push('  4. Write docs/technical-changelog/' + base + '-v<next>.md, grounded in the diff.');
  console.log(L.join('\n'));
}

main();

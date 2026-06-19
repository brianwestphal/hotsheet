// HS-8868 — post-build verification that a Tauri bundle is actually launchable.
//
// The release smoke test (release-candidate.yml `smoke-fresh`) only exercises
// the NPM PACKAGE — it never launches the desktop `.app`, so a non-launching
// bundle (e.g. HS-8867's 0-byte `hotsheet-node` sidecar placeholder) sailed
// through smoke and shipped a beta that hung / white-screened at launch.
//
// This script closes that gap WITHOUT a fragile GUI launch in CI. It runs after
// `tauri build` and asserts the two things whose absence the runtime can't
// recover from:
//   1. The Node sidecar that runs the server is a real binary (non-empty,
//      executable) — not the build-time externalBin placeholder.
//   2. The bundled server can boot — `server/cli.js` is present and non-trivial,
//      and `server/node_modules/@electric-sql/pglite` (the embedded Postgres the
//      server can't start without) is present.
//
// Two layers of checks:
//   - UNIVERSAL (every platform): the staged bundle INPUTS under `src-tauri/`
//     that `tauri build` just packaged — `binaries/hotsheet-node-<triple>` and
//     `server/`. This catches the regression class on Linux / Windows too,
//     where peeking inside the produced `.deb` / `.AppImage` / `.msi` / `.exe`
//     installer would need extra tooling.
//   - macOS DEEP (when a `.app` was produced): inspect the FINAL artifact —
//     `Contents/MacOS/hotsheet-node` + `Contents/Resources/server/` — the exact
//     layout the runtime spawns from. This is the platform where HS-8867
//     actually manifested.
//
// Usage: node scripts/verify-bundle.mjs <target-triple>
// Exits non-zero (failing the release job) on any problem.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

const triple = process.argv[2];
if (!triple) {
  console.error('usage: node scripts/verify-bundle.mjs <target-triple>');
  process.exit(2);
}

const isWindows = triple.includes('windows');
const isMac = triple.includes('apple-darwin');
const ext = isWindows ? '.exe' : '';

// A real Node v20 runtime is tens of MB; cli.js is ~2MB. These floors sit far
// below the real sizes and far above the 0-byte / stub placeholders, so they
// can't false-positive on a genuine build nor false-pass on a broken one.
const MIN_SIDECAR_BYTES = 1_000_000;
const MIN_CLI_BYTES = 100_000;

const errors = [];

function fail(msg) {
  errors.push(msg);
  console.error(`  ✗ ${msg}`);
}

function ok(msg) {
  console.log(`  ✓ ${msg}`);
}

function isExecutable(path) {
  // Windows has no Unix exec bit; the `.exe` extension is the contract there.
  if (isWindows) return true;
  return (statSync(path).mode & 0o111) !== 0;
}

// Verify a "hotsheet-node" sidecar + a "server/" dir rooted at `root`, labeling
// failures with `label` so the universal vs. macOS-deep passes are
// distinguishable in the log.
function verifyTree(root, sidecarRel, serverRel, label) {
  console.log(`${label}:`);

  const sidecar = join(root, sidecarRel);
  if (!existsSync(sidecar)) {
    fail(`${label}: sidecar missing at ${sidecar}`);
  } else {
    const bytes = statSync(sidecar).size;
    if (bytes < MIN_SIDECAR_BYTES) {
      fail(`${label}: sidecar ${sidecar} is too small (${bytes} bytes) — looks like the externalBin placeholder, not a real Node runtime`);
    } else if (!isExecutable(sidecar)) {
      fail(`${label}: sidecar ${sidecar} is not executable`);
    } else {
      ok(`sidecar ${sidecarRel} (${bytes} bytes, executable)`);
    }
  }

  const cli = join(root, serverRel, 'cli.js');
  if (!existsSync(cli)) {
    fail(`${label}: ${serverRel}/cli.js missing at ${cli}`);
  } else {
    const bytes = statSync(cli).size;
    if (bytes < MIN_CLI_BYTES) {
      fail(`${label}: ${serverRel}/cli.js is too small (${bytes} bytes)`);
    } else {
      ok(`${serverRel}/cli.js (${bytes} bytes)`);
    }
  }

  const pglite = join(root, serverRel, 'node_modules', '@electric-sql', 'pglite');
  if (!existsSync(pglite) || !statSync(pglite).isDirectory()) {
    fail(`${label}: bundled @electric-sql/pglite missing at ${pglite} — the server cannot start its database`);
  } else {
    ok(`${serverRel}/node_modules/@electric-sql/pglite`);
  }
}

// HS-8876 — the Apple Foundation Models helper (`apple-fm-helper`) is built ONLY
// for arm64 macOS on a macOS 26 / Xcode 26 runner (FoundationModels SDK). It's a
// hard requirement ONLY when `EXPECT_APPLE_FM_HELPER=1` is set — the workflow
// sets it on the macOS-26 arm64 job. On a `macos-latest` (macOS 15 / no Xcode 26)
// build the helper can't compile and is legitimately absent, so without the flag
// we only log presence/absence rather than failing — otherwise this gate would
// red the pipeline until the runner is moved. A non-empty Swift binary is tens of
// KB; the 1 KB floor sits far below that and above any stub.
function verifyAppleFmHelper(root, serverRel, label) {
  if (triple !== 'aarch64-apple-darwin') return;
  const helper = join(root, serverRel, 'apple-fm-helper');
  const expected = process.env.EXPECT_APPLE_FM_HELPER === '1';
  if (!existsSync(helper)) {
    if (expected) {
      fail(`${label}: apple-fm-helper missing at ${helper} — the macOS 26 SDK build step didn't produce it (is this runner on Xcode 26?)`);
    } else {
      console.log(`  • ${label}: apple-fm-helper not bundled — ok on a non-macOS-26 runner (set EXPECT_APPLE_FM_HELPER=1 to require it)`);
    }
    return;
  }
  const bytes = statSync(helper).size;
  if (bytes < 1000) {
    fail(`${label}: apple-fm-helper ${helper} is suspiciously small (${bytes} bytes) — a failed/stub compile?`);
  } else if (!isExecutable(helper)) {
    fail(`${label}: apple-fm-helper ${helper} is not executable`);
  } else {
    ok(`apple-fm-helper (${bytes} bytes, executable)`);
  }
}

// --- Universal: the staged inputs tauri just bundled (all platforms) ---
const srcTauri = join(repoRoot, 'src-tauri');
verifyTree(
  srcTauri,
  join('binaries', `hotsheet-node-${triple}${ext}`),
  'server',
  'staged bundle inputs (src-tauri/)',
);
verifyAppleFmHelper(srcTauri, 'server', 'staged bundle inputs (src-tauri/)');

// --- macOS deep: the produced .app, the exact layout the runtime spawns from ---
if (isMac) {
  const macosBundleDir = join(srcTauri, 'target', triple, 'release', 'bundle', 'macos');
  if (!existsSync(macosBundleDir)) {
    fail(`macOS .app bundle dir not found at ${macosBundleDir} (did tauri build run for ${triple}?)`);
  } else {
    const apps = readdirSync(macosBundleDir).filter((n) => n.endsWith('.app'));
    if (apps.length === 0) {
      fail(`no .app found under ${macosBundleDir}`);
    } else {
      for (const app of apps) {
        const appRoot = join(macosBundleDir, app, 'Contents');
        verifyTree(appRoot, join('MacOS', 'hotsheet-node'), join('Resources', 'server'), `produced ${app}`);
        verifyAppleFmHelper(appRoot, join('Resources', 'server'), `produced ${app}`);
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`\nverify-bundle: ${errors.length} problem(s) — refusing to ship a non-launchable bundle.`);
  process.exit(1);
}
console.log('\nverify-bundle: all checks passed.');

// Ensure the Tauri build-time resource checks pass for `cargo test` (test:rust).
//
// `cargo test` compiles the Tauri crate, whose build.rs calls
// `tauri_build::try_build(...)`. Since the Tauri 2.11 bump (HS-8828) that build
// step VALIDATES that the `externalBin` and `resources` declared in
// tauri.conf.json actually exist on disk for the build target, and panics when
// they don't:
//   - `externalBin: ["binaries/hotsheet-node"]`  → "resource path
//     `binaries/hotsheet-node-<triple>` doesn't exist"
//   - `resources: ["server/**/*", ...]`          → "glob pattern server/**/*
//     path not found or didn't match any files"
// Both the Node sidecar binary and the `server/` bundle are large artifacts
// produced by `scripts/build-sidecar.sh`, only needed for an actual `tauri
// build`; the Rust unit tests never use them. The CI `rust` job and the release
// workflows' fail-fast `test:rust` (which runs BEFORE build-sidecar.sh) have
// neither yet, so we drop minimal placeholders to satisfy the existence checks.
//
// Placeholders are created ONLY when the real artifact is absent, so a dev
// machine / a post-build-sidecar checkout is never touched. They never reach a
// real bundle: `tauri build` only bundles `hotsheet-node-<its target>` (never
// the host placeholder), and build-sidecar.sh `rm -rf`s `server/` before
// populating it. The sidecar path is gitignored.
import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function hostTriple() {
  // `rustc -vV` prints a line `host: <triple>`.
  const out = execFileSync('rustc', ['-vV'], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('host:'));
  if (line === undefined) throw new Error('could not parse host triple from `rustc -vV`');
  return line.slice('host:'.length).trim();
}

// 1. externalBin — the Node sidecar binary for the host target triple.
const triple = hostTriple();
const ext = triple.includes('windows') ? '.exe' : '';
const binDir = join(repoRoot, 'src-tauri', 'binaries');
const sidecar = join(binDir, `hotsheet-node-${triple}${ext}`);
if (existsSync(sidecar)) {
  console.log(`sidecar placeholder: ${sidecar} already exists — leaving it`);
} else {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(sidecar, '');
  if (ext === '') chmodSync(sidecar, 0o755);
  console.log(`sidecar placeholder: created empty ${sidecar} for cargo test`);
}

// 2. resources — the `server/**/*` glob needs at least one matching file.
const serverDir = join(repoRoot, 'src-tauri', 'server');
const hasServerFiles = existsSync(serverDir) && readdirSync(serverDir).length > 0;
if (hasServerFiles) {
  console.log(`server resources: ${serverDir} already populated — leaving it`);
} else {
  mkdirSync(serverDir, { recursive: true });
  writeFileSync(join(serverDir, 'placeholder'), 'Placeholder so the tauri `server/**/*` resources glob matches during cargo test. Replaced by scripts/build-sidecar.sh for a real bundle.\n');
  console.log(`server resources: created placeholder in ${serverDir} for cargo test`);
}

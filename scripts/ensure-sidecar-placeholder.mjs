// Ensure a placeholder Tauri sidecar binary exists for the host target triple.
//
// `cargo test` (npm run test:rust) compiles the Tauri crate, whose build.rs
// calls `tauri_build::try_build(...)`. Since the Tauri 2.11 bump (HS-8828) that
// build step VALIDATES that every `externalBin` declared in tauri.conf.json
// (`binaries/hotsheet-node`) actually exists on disk for the build target — and
// panics with "resource path `binaries/hotsheet-node-<triple>` doesn't exist"
// when it doesn't. The real sidecar is a large Node binary built by
// `scripts/build-sidecar.sh`, only needed for an actual bundle; the Rust unit
// tests never run it. So for `cargo test` (CI `rust` job + the release
// workflows' fail-fast `test:rust` before the sidecar build) we drop a 0-byte
// executable placeholder so the existence check passes. It's created ONLY when
// missing, so a real sidecar (dev machine, or after build-sidecar.sh) is never
// clobbered, and `tauri build --target X` only bundles `hotsheet-node-X` (never
// this host placeholder).
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

// HS-8714 — cross-platform Playwright `webServer` launcher, replacing the old
// hard Unix-shell command (`export HOME=$(mktemp -d) && … && npx tsx … --data-dir
// /tmp/hotsheet-e2e-$(date +%s%N) …`) that cmd.exe can't run. It (1) isolates the
// global home so the E2E server never touches a real ~/.hotsheet, (2) picks a
// unique temp data dir, (3) builds the client assets, then (4) spawns the server
// via `node --import tsx` (no `npx`, which ENOENTs on Windows).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = mkdtempSync(join(tmpdir(), 'hs-e2e-home-'));
const dataDir = mkdtempSync(join(tmpdir(), 'hs-e2e-data-'));
const pluginsEnabled = process.env.PLUGINS_ENABLED ?? 'true';

// os.homedir() reads HOME on POSIX and USERPROFILE on Windows — set both so the
// isolated home takes effect on every platform.
const env = { ...process.env, HOME: home, USERPROFILE: home, PLUGINS_ENABLED: pluginsEnabled };

// 1. Build client assets first (the server serves them statically).
const build = spawnSync(process.execPath, [join(root, 'scripts', 'build-client.mjs')], {
  cwd: root, env, stdio: 'inherit',
});
if (build.status !== 0) process.exit(build.status ?? 1);

// 2. Launch the server. `node --import tsx src/cli.ts` runs the TypeScript entry
//    directly and is identical across platforms (unlike `npx tsx`).
const server = spawn(
  process.execPath,
  ['--import', 'tsx', join(root, 'src', 'cli.ts'), '--data-dir', dataDir, '--no-open', '--port', '4190', '--strict-port'],
  { cwd: root, env, stdio: 'inherit' },
);

server.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => server.kill(sig));
}

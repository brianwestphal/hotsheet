// HS-9352 — build the client bundle ONCE before the workers start.
//
// Previously the single Playwright `webServer` (scripts/e2e-server.mjs) built
// the client before serving. Now each worker spawns its own server (see the
// `workerServer` fixture in coverage-fixture.ts), so the build has to happen up
// front instead — the per-worker servers only serve the already-built
// dist/client assets.
//
// Skipped when NO_WEB_SERVER is set: that's the coverage path (scripts/test-all.sh),
// which builds the client itself and spawns its own single external server before
// invoking Playwright.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export default function globalSetup(): void {
  if (process.env.NO_WEB_SERVER !== undefined && process.env.NO_WEB_SERVER !== '') return;
  const build = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-client.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (build.status !== 0) {
    throw new Error(`HS-9352 — client build failed (exit ${String(build.status)}) before e2e run`);
  }
}

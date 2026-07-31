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
  // HS-9533/HS-9510 — bounded. This is the most consequential place in the suite
  // to leave a sync spawn unbounded: it runs once, before any worker starts, and
  // `spawnSync` blocks inside native code, so a build that never exits is not a
  // slow run — it is a Playwright process that never gets to report anything.
  // That is exactly HS-9391's signature, and it was invisible here because `e2e/`
  // was not linted at all until HS-9523.
  //
  // `killSignal` is not belt-and-braces: `timeout` is enforced by SENDING it, and
  // the default SIGTERM can be ignored by whatever the build shelled out to.
  const build = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-client.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    timeout: 300_000,
    killSignal: 'SIGKILL',
  });
  if (build.error !== undefined) {
    throw new Error(`HS-9352 — client build could not run before e2e: ${build.error.message}`);
  }
  // A timeout kill surfaces as a signal, not a non-zero status, so check it
  // explicitly — otherwise `status === null` compares unequal to 0 and reports a
  // misleading "exit null" instead of naming the timeout.
  if (build.signal !== null) {
    throw new Error(`HS-9352 — client build killed by ${build.signal} (5 min timeout) before e2e run`);
  }
  if (build.status !== 0) {
    throw new Error(`HS-9352 — client build failed (exit ${String(build.status)}) before e2e run`);
  }
}

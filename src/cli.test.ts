/**
 * HS-5187: CLI argument parsing and server startup tests.
 *
 * Tests the arg parsing logic directly (unit) and key server behaviors
 * via process spawning (integration).
 */
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { computeIsEntryPoint } from './cli.js';
// HS-8202 — the spawn-test gate lives in spawnTestServer.ts (shared with the
// *.e2e.test.ts suites) so all spawn-bearing tests agree on when it's safe to
// spawn a real CLI child. It is true only when tsx can really spawn a child
// here (the probe executes a throwaway `.ts` file rather than `tsx --help`,
// the only way to catch the partial sandbox that denies tsx's IPC unix-socket
// `listen`) AND we're not running inside a Hot Sheet terminal.
import { canRunServerSpawnTests } from './spawnTestServer.js';

// We can't import parseArgs directly (it's not exported), so test via
// spawning the CLI process and checking its behavior.

const CLI_PATH = join(process.cwd(), 'src', 'cli.ts');

async function spawn(args: string[], opts?: { timeout?: number; env?: Record<string, string> }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { execFile } = await import('child_process');
  return new Promise((resolve) => {
    // HS-8419 — bumped from 5000 → 15000ms. Under heavy CI-runner load
    // `npx tsx src/cli.ts --help` can take > 5 s (npx prefix resolution +
    // tsx loader warm-up + Node start-up), and the timeout fires with
    // `error.status = undefined` which the resolver below collapses to
    // exitCode 1 — making the test appear to fail with
    // `expected 1 to be +0` even though the CLI behavior is correct.
    const proc = execFile('npx', ['tsx', CLI_PATH, ...args], {
      timeout: opts?.timeout ?? 15000,
      env: { ...process.env, ...opts?.env },
    }, (error, stdout, stderr) => {
      resolve({
        stdout,
        stderr,
        exitCode: error ? (error as { status?: number }).status ?? 1 : 0,
      });
    });
    // For server-starting commands, kill after a short delay
    if (!args.includes('--help') && !args.includes('--list') && !args.includes('--close') && !args.includes('--version')) {
      setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }, 2000);
    }
  });
}

// HS-8419 — `it.extend({ retry: 2 })` wraps the spawn-bearing tests with
// vitest's per-test retry. The probe at module load proves tsx CAN spawn,
// but under CI load an individual `npx tsx --help` invocation can still
// exceed the 15s timeout (npm cache miss → resolver round trip → tsx
// loader warm-up). Two retries = three total attempts, which is empirically
// enough to absorb the tail of the spawn-latency distribution without
// hiding a genuine regression (a real break would fail all three).
describe.skipIf(!canRunServerSpawnTests)('CLI — help and version (skipped: no tsx child-spawn here, or running inside a Hot Sheet terminal; HS-8202)', () => {
  it('--help prints usage and exits 0', { retry: 2 }, async () => {
    const { stdout, exitCode } = await spawn(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('--port');
    expect(stdout).toContain('--data-dir');
    expect(stdout).toContain('--no-open');
  });

  it('-h is an alias for --help', { retry: 2 }, async () => {
    const { stdout, exitCode } = await spawn(['-h']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage:');
  });

  // Note: --version is not a supported flag (exits 1 as unknown option).
  // Version info is shown in the --help output instead.

  it('unknown option prints error and exits 1', async () => {
    const { stderr, exitCode } = await spawn(['--bogus']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Unknown option');
  });
});

describe.skipIf(!canRunServerSpawnTests)('CLI — server startup with custom args (skipped: no tsx child-spawn here, or running inside a Hot Sheet terminal; HS-8202)', () => {
  const tempDir = join(tmpdir(), `hs-cli-test-${Date.now()}`);
  const tempHome = join(tmpdir(), `hs-cli-home-${Date.now()}`);
  const dataDir = join(tempDir, '.hotsheet');

  afterAll(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // Use isolated HOME so test servers don't pollute the real projects.json
  const isolatedEnv = { HOME: tempHome };

  it('--port and --data-dir are accepted (server starts on custom port)', async () => {
    mkdirSync(dataDir, { recursive: true });
    // Start the server on a high port with --no-open and kill it after 2s.
    // If the args are accepted, stdout should show the startup message.
    const { stdout, stderr } = await spawn([
      '--port', '4199', '--data-dir', dataDir, '--no-open', '--strict-port',
    ], { timeout: 4000, env: isolatedEnv });
    // The server should print the running URL or at least not error on arg parsing
    const combined = stdout + stderr;
    expect(combined).not.toContain('Unknown option');
    // Should either show "running at" or be killed before printing (both OK)
  });

  it('--no-open prevents browser opening (no open command spawned)', async () => {
    mkdirSync(dataDir, { recursive: true });
    const { stdout, stderr } = await spawn([
      '--port', '4198', '--data-dir', dataDir, '--no-open', '--strict-port',
    ], { timeout: 4000, env: isolatedEnv });
    // With --no-open, the server starts but doesn't call open().
    // We can't directly verify open() wasn't called, but we verify the flag is accepted.
    const combined = stdout + stderr;
    expect(combined).not.toContain('Unknown option');
  });

  it('invalid --port prints error', async () => {
    const { stderr, exitCode } = await spawn(['--port', 'abc']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid port');
  });

  it('invalid --demo: prints error', async () => {
    const { stderr, exitCode } = await spawn(['--demo:0']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('Invalid demo');
  });
});

describe.skipIf(!canRunServerSpawnTests)('CLI — instance file and lock cleanup (skipped: no tsx child-spawn here, or running inside a Hot Sheet terminal; HS-8202)', () => {
  it('stale instance file does not prevent startup', async () => {
    const tempDir = join(tmpdir(), `hs-stale-${Date.now()}`);
    const dataDir = join(tempDir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    // Write a stale instance file with a PID that doesn't exist
    const globalDir = join(tmpdir(), `hs-home-${Date.now()}`, '.hotsheet');
    mkdirSync(globalDir, { recursive: true });
    writeFileSync(join(globalDir, 'instance.json'), JSON.stringify({
      port: 4197, pid: 999999, startedAt: new Date().toISOString(),
    }));

    const { stdout, stderr } = await spawn([
      '--port', '4197', '--data-dir', dataDir, '--no-open', '--strict-port',
    ], {
      timeout: 4000,
      env: { HOME: join(tmpdir(), `hs-home-${Date.now()}`) },
    });

    const combined = stdout + stderr;
    expect(combined).not.toContain('already running');

    // Cleanup
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(globalDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });
});

// Pure regression test for the entry-point detection. When the bundled
// cli.js sits at a path that contains a URL-reserved character (e.g. the
// space in `/Applications/Hot Sheet.app/...`), the raw `file://${argv1}`
// compare used previously failed because `import.meta.url` percent-encodes
// the space (`%20`) while `process.argv[1]` keeps it raw — so main() never
// ran and the sidecar exited silently with code 0.
describe('computeIsEntryPoint', () => {
  it('matches a plain bundled path', () => {
    expect(computeIsEntryPoint(
      '/Users/dev/Documents/hotsheet/dist/cli.js',
      'file:///Users/dev/Documents/hotsheet/dist/cli.js',
    )).toBe(true);
  });

  it('matches when the path contains a space (e.g. /Applications/Hot Sheet.app/...)', () => {
    expect(computeIsEntryPoint(
      '/Applications/Hot Sheet.app/Contents/Resources/server/cli.js',
      'file:///Applications/Hot%20Sheet.app/Contents/Resources/server/cli.js',
    )).toBe(true);
  });

  it('matches tsx invocation by basename when both ends are cli.ts', () => {
    expect(computeIsEntryPoint(
      '/Users/dev/hotsheet/src/cli.ts',
      'file:///Users/dev/hotsheet/src/cli.ts',
    )).toBe(true);
  });

  it('returns false for an unrelated import.meta.url', () => {
    expect(computeIsEntryPoint(
      '/Users/dev/hotsheet/dist/cli.js',
      'file:///Users/dev/hotsheet/dist/other.js',
    )).toBe(false);
  });

  it('returns false when argv1 is missing', () => {
    expect(computeIsEntryPoint(undefined, 'file:///x/cli.js')).toBe(false);
    expect(computeIsEntryPoint('', 'file:///x/cli.js')).toBe(false);
  });

  // HS-8457 — when `npm install -g hotsheet` puts a symlink at
  // /usr/local/bin/hotsheet pointing at the real cli.js,
  // `process.argv[1]` is the symlink path but `import.meta.url` is the
  // resolved real path. Pre-fix the equality check failed, `main()` never
  // ran, and the CLI exited cleanly with code 0 and no output — caught
  // for the first time by the smoke tests against v0.17.0-rc.1.
  it('matches an npm-installed symlink (argv[1] is the bin shim)', () => {
    const fakeRealpath = (p: string): string => {
      if (p === '/usr/local/bin/hotsheet') return '/usr/local/lib/node_modules/hotsheet/dist/cli.js';
      return p;
    };
    expect(computeIsEntryPoint(
      '/usr/local/bin/hotsheet',
      'file:///usr/local/lib/node_modules/hotsheet/dist/cli.js',
      fakeRealpath,
    )).toBe(true);
  });

  it('still returns false when the realpath resolves to an unrelated file', () => {
    const fakeRealpath = (p: string): string => {
      if (p === '/usr/local/bin/other-tool') return '/some/other/path.js';
      return p;
    };
    expect(computeIsEntryPoint(
      '/usr/local/bin/other-tool',
      'file:///usr/local/lib/node_modules/hotsheet/dist/cli.js',
      fakeRealpath,
    )).toBe(false);
  });

  it('tolerates realpath throwing (e.g. dangling symlink)', () => {
    const throwingRealpath = (): string => { throw new Error('ENOENT'); };
    expect(computeIsEntryPoint(
      '/usr/local/bin/hotsheet',
      'file:///usr/local/lib/node_modules/hotsheet/dist/cli.js',
      throwingRealpath,
    )).toBe(false);
  });
});

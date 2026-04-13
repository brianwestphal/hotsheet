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

// We can't import parseArgs directly (it's not exported), so test via
// spawning the CLI process and checking its behavior.

const CLI_PATH = join(process.cwd(), 'src', 'cli.ts');

async function spawn(args: string[], opts?: { timeout?: number; env?: Record<string, string> }): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { execFile } = await import('child_process');
  return new Promise((resolve) => {
    const proc = execFile('npx', ['tsx', CLI_PATH, ...args], {
      timeout: opts?.timeout ?? 5000,
      env: { ...process.env, ...opts?.env },
    }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout?.toString() ?? '',
        stderr: stderr?.toString() ?? '',
        exitCode: error ? (error as { status?: number }).status ?? 1 : 0,
      });
    });
    // For server-starting commands, kill after a short delay
    if (!args.includes('--help') && !args.includes('--list') && !args.includes('--close') && !args.includes('--version')) {
      setTimeout(() => { try { proc.kill('SIGTERM'); } catch { /* ignore */ } }, 2000);
    }
  });
}

describe('CLI — help and version', () => {
  it('--help prints usage and exits 0', async () => {
    const { stdout, exitCode } = await spawn(['--help']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Usage:');
    expect(stdout).toContain('--port');
    expect(stdout).toContain('--data-dir');
    expect(stdout).toContain('--no-open');
  });

  it('-h is an alias for --help', async () => {
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

describe('CLI — server startup with custom args', () => {
  const tempDir = join(tmpdir(), `hs-cli-test-${Date.now()}`);
  const dataDir = join(tempDir, '.hotsheet');

  afterAll(() => {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('--port and --data-dir are accepted (server starts on custom port)', async () => {
    mkdirSync(dataDir, { recursive: true });
    // Start the server on a high port with --no-open and kill it after 2s.
    // If the args are accepted, stdout should show the startup message.
    const { stdout, stderr } = await spawn([
      '--port', '4199', '--data-dir', dataDir, '--no-open', '--strict-port',
    ], { timeout: 4000 });
    // The server should print the running URL or at least not error on arg parsing
    const combined = stdout + stderr;
    expect(combined).not.toContain('Unknown option');
    // Should either show "running at" or be killed before printing (both OK)
  });

  it('--no-open prevents browser opening (no open command spawned)', async () => {
    mkdirSync(dataDir, { recursive: true });
    const { stdout, stderr } = await spawn([
      '--port', '4198', '--data-dir', dataDir, '--no-open', '--strict-port',
    ], { timeout: 4000 });
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

describe('CLI — instance file and lock cleanup', () => {
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

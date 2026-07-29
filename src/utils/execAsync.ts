/**
 * HS-9498 — promisified `exec` / `execFile` that resolve `child_process` LAZILY.
 *
 * ## Why this exists
 *
 * The idiomatic `const execFileAsync = promisify(execFile)` at module scope makes a
 * module hostile to import. `promisify(undefined)` throws, so any test that partially
 * mocks `child_process` — for its own unrelated reasons, naming only the exports IT
 * uses — dies at import time the moment such a module appears anywhere in its
 * dependency graph, however indirectly.
 *
 * It is a nasty failure because it is transitive and non-local: the test that breaks
 * has no relationship to the module that broke it, the error names a file the author
 * never heard of, and it takes down the WHOLE file rather than a case.
 *
 * This bit twice. HS-8723: `git/status.ts` reached `routes/dashboard.test.ts` and the
 * fix was to add `execFile: vi.fn()` to that test's mock. HS-9498: `systemMemoryPressure.ts`
 * (docs/131) reached `routes/dashboard.test.ts` AND `routes/shell.test.ts` through the
 * docs/128 eviction path, and both files had been failing at import since 2026-07-27.
 *
 * Patching each mock treats the symptom — every future test that mocks `child_process`
 * inherits the trap, and only discovers it by tripping over it. Resolving the import
 * inside the call removes the trap: a mock missing the export now fails where the call
 * is made, inside whatever error handling that caller already has, instead of during
 * module evaluation.
 *
 * ## Cost
 *
 * One `await import()` per call, against a module the runtime has already loaded and
 * cached after the first use. Every caller here is already spawning a process, so the
 * import is noise next to the fork.
 */
import { promisify } from 'node:util';

export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** Options accepted by `child_process.exec` that callers here actually use. */
export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
  encoding?: BufferEncoding;
  windowsHide?: boolean;
}

/**
 * Node types `exec`/`execFile` stdout as `string`, but it is a `Buffer` when the
 * caller asks for one and on some failure modes — `git/status.ts::bufToStr` exists
 * for exactly that reason. Coercing through a widened type keeps the declared
 * `string` honest instead of asserting it (docs/CLAUDE.md § Type assertions).
 */
function toText(value: string | Buffer): string {
  return typeof value === 'string' ? value : value.toString();
}

/** `promisify(exec)` with a lazily-resolved `child_process`. */
export async function execAsync(command: string, options: ExecOptions = {}): Promise<ExecResult> {
  const { exec } = await import('node:child_process');
  const res: { stdout: string | Buffer; stderr: string | Buffer } =
    await promisify(exec)(command, options);
  return { stdout: toText(res.stdout), stderr: toText(res.stderr) };
}

/** `promisify(execFile)` with a lazily-resolved `child_process`. */
export async function execFileAsync(
  file: string,
  args: readonly string[] = [],
  options: ExecOptions = {},
): Promise<ExecResult> {
  const { execFile } = await import('node:child_process');
  const res: { stdout: string | Buffer; stderr: string | Buffer } =
    await promisify(execFile)(file, [...args], options);
  return { stdout: toText(res.stdout), stderr: toText(res.stderr) };
}

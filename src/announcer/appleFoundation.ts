/**
 * §78 Announcer (HS-8790) — the **Apple Foundation Models** provider.
 *
 * Apple's on-device LLM is only reachable from native macOS (Swift
 * `FoundationModels`), which the Node server can't call directly. The fix (per
 * the design discussion): a tiny bundled **Swift CLI helper** that the server
 * shells out to — `--probe` reports availability, `--summarize` reads
 * `{system, material}` JSON on stdin and writes `{entries:[…]}` JSON on stdout.
 * Because the *server* runs it, this works in BOTH the manual "Listen" path and
 * the server-driven live-mode generator (no client round-trip needed).
 *
 * Resolution: the bundled-binary path comes from `HOTSHEET_APPLE_FM_BIN`
 * (set by the Tauri launcher / build), with a `cwd` fallback. On non-darwin, a
 * missing binary, or a failing probe, the provider reports unavailable and the
 * caller falls back to Anthropic. The native compile + code-sign + on-device run
 * are a desktop concern (see docs/tauri-architecture.md); everything here is
 * pure Node and unit-tested with an injected runner.
 */
import { spawn } from 'node:child_process';

import { existsSync } from 'fs';
import { join } from 'path';

/** Spawn a process, write `stdin`, resolve with its stdout, stderr + exit code.
 *  `stderr` is optional so test runners can omit it; production callers capture
 *  it because the Swift helper writes its failure detail there (e.g. the exact
 *  `inference failed: <error>` behind a non-zero exit). */
export type ProcessRunner = (bin: string, args: string[], stdin: string) => Promise<{ stdout: string; code: number; stderr?: string }>;

const defaultRunner: ProcessRunner = (bin, args, stdin) =>
  new Promise((resolve, reject) => {
    // stderr is PIPED (not ignored): the helper writes its diagnostic reason
    // there (`fail(message, code)` in main.swift). Discarding it left every
    // failure as a bare "exited with code N" with no way to tell WHY on-device
    // inference failed (HS-8883).
    const child = spawn(bin, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf-8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ stdout, stderr, code: code ?? 0 }));
    child.stdin.end(stdin);
  });

let runner: ProcessRunner = defaultRunner;
/** Apple Foundation Models are macOS-only; injectable so the availability matrix
 *  is testable on Linux CI. */
let isDarwin: boolean = process.platform === 'darwin';
/** Cached availability — the OS-model state changes rarely within a session. */
let availabilityCache: boolean | null = null;

/** Absolute path to the bundled Swift helper, or null when it isn't present. */
export function appleFmBinPath(): string | null {
  const env = process.env.HOTSHEET_APPLE_FM_BIN;
  if (env !== undefined && env !== '' && existsSync(env)) return env;
  const fallback = join(process.cwd(), 'apple-fm-helper');
  if (existsSync(fallback)) return fallback;
  return null;
}

/**
 * Whether on-device Apple Foundation Models can be used right now: macOS, the
 * helper binary present, and its `--probe` reporting `available` (macOS 26 +
 * Apple Intelligence enabled + model downloaded). Cached after the first check.
 */
export async function isAppleFoundationAvailable(): Promise<boolean> {
  if (availabilityCache !== null) return availabilityCache;
  availabilityCache = await probeAvailability();
  return availabilityCache;
}

async function probeAvailability(): Promise<boolean> {
  if (!isDarwin) return false;
  const bin = appleFmBinPath();
  if (bin === null) return false;
  try {
    const { stdout, code } = await runner(bin, ['--probe'], '');
    return code === 0 && stdout.trim().toLowerCase().startsWith('available');
  } catch {
    return false;
  }
}

/**
 * Run one on-device summarization. Returns the helper's raw stdout (expected to
 * be `{entries:[…]}` JSON — the caller validates it with the shared schema, the
 * same way the Anthropic path validates the model's JSON). Throws if the helper
 * is missing or exits non-zero.
 */
export async function runAppleFoundationSummarize(system: string, material: string): Promise<string> {
  const bin = appleFmBinPath();
  if (bin === null) throw new Error('Apple Foundation Models helper not found');
  const { stdout, stderr, code } = await runner(bin, ['--summarize'], JSON.stringify({ system, material }));
  if (code !== 0) {
    // Surface the helper's stderr reason (HS-8883) — e.g. "inference failed:
    // <FoundationModels error>" — so the soft-failure log is actionable instead
    // of a bare exit code. Common code-4 causes: the on-device model throwing on
    // a guardrail violation or an oversized prompt past its small context window.
    const detail = stderr?.trim();
    throw new Error(
      `Apple Foundation Models helper exited with code ${code}${detail !== undefined && detail !== '' ? `: ${detail}` : ''}`,
    );
  }
  return stdout;
}

/** **TEST ONLY** — inject a fake process runner + pretend-platform. */
export function _setAppleFoundationForTesting(opts: { runner?: ProcessRunner; darwin?: boolean }): void {
  if (opts.runner !== undefined) runner = opts.runner;
  if (opts.darwin !== undefined) isDarwin = opts.darwin;
  availabilityCache = null;
}

/** **TEST ONLY** — clear the availability cache + restore real wiring. */
export function _resetAppleFoundationForTesting(): void {
  runner = defaultRunner;
  isDarwin = process.platform === 'darwin';
  availabilityCache = null;
}

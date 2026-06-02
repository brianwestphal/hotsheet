import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

// HS-8704 regression: the installed (Tauri) beta app got stuck forever on the
// "Starting Hot Sheet…" splash screen.
//
// Root-cause CLASS this guards: the splash → app transition is driven by a
// fragile, implicit, cross-language contract. The Tauri Rust shell
// (`src-tauri/src/lib.rs`) reads the sidecar's stdout line by line and only
// navigates the WebView off the splash when it finds one of two exact magic
// substrings:
//
//   • "running at "               — emitted by `src/server.ts` when this
//                                    process starts its own HTTP server.
//   • "running instance on port " — emitted by `src/cli.ts` when this process
//                                    instead registers against an already
//                                    running instance and exits.
//
// If either log line is reworded (they look like ordinary cosmetic
// `console.log`s, so this is very easy to do by accident) the Rust matcher
// silently never fires, `window.navigate(...)` is never called, and the
// installed app spins on the splash indefinitely. NOTHING else in the test
// suite exercises this handshake — the e2e/lifecycle tests poll `/api/stats`
// over HTTP and never go through the Tauri stdout navigator — so the break
// ships completely green.
//
// These tests pin the producer (TS) and consumer (Rust) sides of the contract
// together: change the wording on one side without the other and CI fails,
// pointing the editor straight at this file and the cross-file dependency.
//
// The Rust slices the URL/port out with `&line[idx + "running at ".len()..]`,
// so the trailing space is load-bearing — we assert the exact trailing-space
// forms, not a loose match.
describe('launch-readiness sidecar→Tauri stdout contract (HS-8704)', () => {
  const repoRoot = process.cwd();
  const read = (...parts: string[]): string => readFileSync(join(repoRoot, ...parts), 'utf8');

  const RUNNING_AT = 'running at ';
  const RUNNING_INSTANCE = 'running instance on port ';

  it('src/server.ts emits the "running at " line the Tauri navigator greps for', () => {
    const server = read('src', 'server.ts');
    // Must be logged to stdout (console.log) — the Tauri sidecar only reads
    // CommandEvent::Stdout, so a console.error here would never be seen.
    expect(server).toMatch(/console\.log\([^)]*running at /);
    expect(server).toContain(RUNNING_AT);
  });

  it('src/cli.ts emits the "running instance on port " line for the join path', () => {
    const cli = read('src', 'cli.ts');
    expect(cli).toMatch(/console\.log\([^)]*running instance on port /);
    expect(cli).toContain(RUNNING_INSTANCE);
  });

  it('src-tauri/src/lib.rs searches sidecar stdout for BOTH magic substrings', () => {
    const lib = read('src-tauri', 'src', 'lib.rs');
    // The exact, trailing-space literals the navigator slices against.
    expect(lib).toContain(`.find("${RUNNING_AT}")`);
    expect(lib).toContain(`.find("${RUNNING_INSTANCE}")`);
  });

  it('lib.rs wires both navigation cases in the production AND dev startup paths', () => {
    const lib = read('src-tauri', 'src', 'lib.rs');
    // Production sidecar path (`spawn_sidecar_and_navigate`) and the
    // `#[cfg(debug_assertions)]` dev path each contain one match for each
    // string — drop either branch and one launch mode silently regresses.
    const countOf = (needle: string): number => lib.split(needle).length - 1;
    expect(countOf(`.find("${RUNNING_AT}")`)).toBeGreaterThanOrEqual(2);
    expect(countOf(`.find("${RUNNING_INSTANCE}")`)).toBeGreaterThanOrEqual(2);
  });

  it('the producer literals exactly match the consumer literals (no drift)', () => {
    // Belt-and-suspenders: extract every `.find("…")` argument from lib.rs and
    // assert the two readiness markers are present verbatim. If a future
    // refactor renames the Rust constant or the TS log, the equality below is
    // what fails — keeping the two sides honest without anyone remembering
    // this contract exists.
    const lib = read('src-tauri', 'src', 'lib.rs');
    const finds = [...lib.matchAll(/\.find\("([^"]*)"\)/g)].map(m => m[1]);
    expect(finds).toContain(RUNNING_AT);
    expect(finds).toContain(RUNNING_INSTANCE);
  });
});

// HS-8706 — the actual ROOT CAUSE behind the HS-8704 hang. The installed app's
// startup.log gapped after "initializing project" because `acquireLock`
// (src/lock.ts) classified an orphaned project lock — a recycled PID left by a
// SIGKILL'd instance, whose global instance file `cleanupStaleInstance` had
// already removed — as a live instance and `process.exit(1)`-ed the sidecar
// BEFORE the server started. On a GUI launch the `console.error` vanished and
// the splash spun forever. The behavioral fix lives in `classifyExistingLock`'s
// `reclaimUnverified` policy (covered by lock.test.ts); these source-contract
// tests pin the two things lock.test.ts can't see in isolation: that the boot
// paths actually PASS the hint, and that the surviving fatal exit is durable.
describe('orphaned-lock launch-hang contract (HS-8706)', () => {
  const repoRoot = process.cwd();
  const read = (...parts: string[]): string => readFileSync(join(repoRoot, ...parts), 'utf8');

  it('cli.ts primary-startup acquire passes reclaimUnverified so an orphaned lock is reclaimed, not fatal', () => {
    const cli = read('src', 'cli.ts');
    // HS-8706 (fourth pass) — the primary path now uses the WAITING acquire
    // (`acquireLockWaitingForShutdown`), but it must still thread the
    // `reclaimUnverified` hint so a recycled-PID orphan is reclaimed.
    expect(cli).toMatch(/acquireLockWaitingForShutdown\(dataDir,\s*\{\s*reclaimUnverified:\s*true\s*\}\)/);
  });

  it('projects.ts registerProject acquireLock passes reclaimUnverified (the runtime Open-Folder + restore path)', () => {
    const projects = read('src', 'projects.ts');
    expect(projects).toMatch(/acquireLock\(absDataDir,\s*\{\s*reclaimUnverified:\s*true\s*\}\)/);
  });

  it('lock.ts routes its surviving fatal exit through the DURABLE startup log, not a bare console.error', () => {
    // The whole reason HS-8704 was undiagnosable: the lock conflict exited via
    // `console.error` (invisible on a GUI launch) with no entry in the
    // persisted startup.log. The fatal `process.exit(1)` must be preceded by a
    // `startupLog(...)` call so a future occurrence names itself in the log.
    const lock = read('src', 'lock.ts');
    expect(lock).toContain("import { startupLog } from './startup-log.js'");
    // The durable FATAL log must precede the actual fatal exit statement. (The
    // first textual `process.exit(1)` is inside a doc comment, so search for the
    // real exit STATEMENT — trailing semicolon — that follows the log call.)
    const logIdx = lock.indexOf('startupLog(`[startup] FATAL');
    const exitIdx = lock.indexOf('process.exit(1);', logIdx);
    expect(logIdx).toBeGreaterThanOrEqual(0);
    expect(exitIdx).toBeGreaterThan(logIdx);
  });

  it('init-project phase markers bracket the lock step so a lock-exit pins to it in startup.log', () => {
    // The HS-8704 trace gapped between "initializing project" and
    // "init-project: initializing DB" with nothing in between — we had to read
    // code to find acquireLock. The explicit "acquiring lock" marker names the
    // phase so the next occurrence is self-evident from the log alone.
    const cli = read('src', 'cli.ts');
    expect(cli).toContain("startupMark('init-project: acquiring lock')");
  });
});

// HS-8706 (the ACTUAL fix) — the orphaned-lock theory above was a real but
// LATENT hardening; it was NOT what hung this user's launch. The captured
// startup.log showed the server reach "starting server", emit the readiness
// line, then immediately:
//
//   [startup] FATAL: ENOENT: no such file or directory, mkdir '/.claude'
//
// `cli.ts` installed AI tool skills via `ensureSkills()`, which keyed the
// target directory off `process.cwd()`. The Tauri shell spawns the sidecar with
// `cwd = /`, so with `claude` on PATH the writer did `mkdirSync('/.claude')` →
// ENOENT → unhandled throw → FATAL `process.exit` of an already-listening
// server → eternal splash. A direct-from-terminal launch worked only because
// its cwd happened to BE the project root. The behavioral fix (skills written
// relative to `dataDir`'s project root, and made non-fatal) is covered by
// skills.test.ts; these source-contract tests pin the cli.ts wiring that
// skills.test.ts can't see in isolation.
describe('cwd-relative skill-install launch-hang contract (HS-8706)', () => {
  const repoRoot = process.cwd();
  const read = (...parts: string[]): string => readFileSync(join(repoRoot, ...parts), 'utf8');

  it('cli.ts primary-startup installs skills via ensureSkillsForDir, NOT the cwd-based ensureSkills()', () => {
    const cli = read('src', 'cli.ts');
    // The dataDir-derived caller must be used.
    expect(cli).toMatch(/ensureSkillsForDir\(/);
    // The cwd-based ensureSkills() must NOT be called on the startup path — its
    // only safe use was a single-project CLI launch where cwd === project root.
    expect(cli).not.toMatch(/\bensureSkills\(\)/);
  });

  it('cli.ts derives the skill-install root from dataDir (the .hotsheet parent), not process.cwd()', () => {
    const cli = read('src', 'cli.ts');
    // The project root is `resolve(dataDir)` with a trailing `/.hotsheet`
    // stripped — same derivation registerProject uses (HS-8486). Asserted as
    // robust substrings rather than a regex-of-the-regex.
    expect(cli).toContain('resolve(dataDir).replace(');
    expect(cli).toContain('ensureSkillsForDir(projectRoot)');
  });

  it('cli.ts wraps the skill install so a write failure can never abort startup', () => {
    // Defense-in-depth: even with the right path, a read-only fs / permission
    // error must degrade to a warning, never a FATAL exit of a live server.
    const cli = read('src', 'cli.ts');
    const callIdx = cli.indexOf('ensureSkillsForDir(projectRoot)');
    expect(callIdx).toBeGreaterThanOrEqual(0);
    // A `try {` must open before the call and a `[skills]` warn catch follow it.
    const tryIdx = cli.lastIndexOf('try {', callIdx);
    expect(tryIdx).toBeGreaterThanOrEqual(0);
    expect(cli.indexOf('[skills] Failed to install AI tool skills', callIdx)).toBeGreaterThan(callIdx);
  });
});

// HS-8706 (third pass — the cause that survived BOTH prior fixes). The user's
// captured startup.log for the failing GUI launch (sidecar pid 30413) gapped
// straight from "existing-instance: stale cleanup done" to "initializing
// project" — it never logged "checking if instance on port … is running",
// meaning `handleExistingInstance` returned at its `instance === null` guard.
// The instance file had been DELETED by the immediately-preceding
// `cleanupStaleInstance()` pass: the running multi-project server's PID was
// still alive but its HTTP port refused the probe (it was draining during a
// `--replace` handoff). The old `cleanupStaleInstance` had no `pidAlive &&
// !portActive` branch, so it fell through to its unconditional file removal —
// nuking a LIVE owner's instance file. The new launch then concluded "no
// instance running", started its own server for the restored project, and
// collided on the `hotsheet.lock` the live process still held → acquireLock →
// process.exit(1) → eternal "Starting Hot Sheet…" splash.
//
// The behavioral fix (preserve the file when the owner is alive) is covered by
// instance.test.ts. These source-contract tests pin the two cross-file pieces a
// single unit test can't see together: that cleanupStaleInstance has the guard,
// and that cli.ts retries the join probe while the owner PID is alive instead of
// giving up after one failed probe.
describe('live-instance-file-preservation launch-hang contract (HS-8706)', () => {
  const repoRoot = process.cwd();
  const read = (...parts: string[]): string => readFileSync(join(repoRoot, ...parts), 'utf8');

  it('instance.ts cleanupStaleInstance has an explicit pidAlive && !portActive branch that does NOT delete the file', () => {
    const instance = read('src', 'instance.ts');
    // The guard branch must exist and return before the file-removal tail.
    expect(instance).toContain('if (pidAlive && !portActive)');
    const branchIdx = instance.indexOf('if (pidAlive && !portActive)');
    const removalIdx = instance.indexOf('rmSync(getInstanceFilePath()', branchIdx);
    // There must be a `return false;` inside the branch, BEFORE any rmSync that
    // follows it — i.e. the alive-owner case never reaches the removal tail.
    const returnIdx = instance.indexOf('return false;', branchIdx);
    expect(returnIdx).toBeGreaterThanOrEqual(0);
    expect(returnIdx).toBeLessThan(removalIdx);
  });
});

// HS-8706 (fourth pass — the deterministic "every other launch fails"). A CLEAN
// single-app startup.log (no dev-server confound) showed strict alternation:
// a successful launch leaves a sidecar; quitting it runs `gracefulShutdown`,
// whose §73 snapshot + DB-close phases block the event loop for seconds and only
// release `hotsheet.lock` at the very END; a relaunch landing in that window
// finds the port wedged (can't JOIN) AND the lock still held by the alive,
// draining process (can't ACQUIRE) → the old `acquireLock` FATAL-exited
// instantly → splash hang. The fix waits for the shutting-down holder to release
// the lock before giving up. These source-contract tests pin the wiring a unit
// test can't see end-to-end: that the primary boot path uses the WAITING
// acquire, and that the waiter re-classifies each poll (so a SIGKILL'd holder is
// reclaimed, not waited on forever).
describe('shutdown-drain lock-wait launch-hang contract (HS-8706)', () => {
  const repoRoot = process.cwd();
  const read = (...parts: string[]): string => readFileSync(join(repoRoot, ...parts), 'utf8');

  it('cli.ts primary boot path awaits acquireLockWaitingForShutdown, not the instant-exit acquireLock', () => {
    const cli = read('src', 'cli.ts');
    expect(cli).toContain('await acquireLockWaitingForShutdown(dataDir, { reclaimUnverified: true })');
    // The instant-exit acquireLock must NOT be called on the init path (it would
    // FATAL the moment it sees the draining holder's lock).
    expect(cli).not.toMatch(/[^a-zA-Z]acquireLock\(dataDir/);
  });

  it('lock.ts acquireLockWaitingForShutdown polls in a loop and re-classifies each attempt', () => {
    const lock = read('src', 'lock.ts');
    expect(lock).toMatch(/export async function acquireLockWaitingForShutdown\(/);
    // It must call the single-attempt helper repeatedly (re-classifying), not
    // read the lock once — that is what lets a SIGKILL'd holder (pid now dead)
    // become reclaimable mid-wait instead of being waited on until the deadline.
    const fnIdx = lock.indexOf('export async function acquireLockWaitingForShutdown(');
    expect(lock.indexOf('tryAcquireLockOnce(dataDir, opts)', fnIdx)).toBeGreaterThan(fnIdx);
    expect(lock.indexOf('setTimeout', fnIdx)).toBeGreaterThan(fnIdx);
  });

  it('lock.ts only FATAL-exits after the wait deadline, never on the first live observation', () => {
    const lock = read('src', 'lock.ts');
    const fnIdx = lock.indexOf('export async function acquireLockWaitingForShutdown(');
    // The fatal call inside the waiter must be guarded by a deadline check.
    const deadlineIdx = lock.indexOf('Date.now() >= deadline', fnIdx);
    const fatalIdx = lock.indexOf('fatalLockHeld(dataDir, r.pid)', fnIdx);
    expect(deadlineIdx).toBeGreaterThan(fnIdx);
    expect(fatalIdx).toBeGreaterThan(deadlineIdx);
  });
});

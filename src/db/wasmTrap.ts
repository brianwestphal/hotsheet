/**
 * HS-9554 (docs/128) — recognize a PGLite cluster whose WASM instance has TRAPPED.
 *
 * ## The failure this exists for
 *
 * On 2026-08-01 the server was SIGKILLed by the docs/45 watchdog after a 61.7 s
 * event-loop block. The watchdog's own FATAL line called it GC thrash (it prints
 * that whenever memory is above 75% of the limit). The live `sample` it captured
 * one line later says otherwise — 1373 of 1456 samples, a single stack:
 *
 *     Runtime_ThrowWasmError -> Factory::NewWasmRuntimeError
 *       -> ErrorUtils::MakeGenericError -> Isolate::CaptureAndSetErrorStack
 *         -> CaptureSimpleStackTrace -> OptimizedFrame::Summarize (390)
 *                                    -> UnoptimizedFrame::Summarize (337)
 *
 * Not one sample in GC. The loop was pinned **constructing WebAssembly
 * RuntimeErrors**, inside a promise continuation off an inbound HTTP request.
 *
 * A WASM trap costs almost nothing to raise. What costs is the error object: V8
 * captures a stack trace, and on a JIT-optimized async stack that means
 * deoptimizing frame translation (`TranslatedState`, `SafepointTable::FindEntry`,
 * `GetBytecodeOffsetForBaselinePC`) per frame per throw. At ~1.4 s of wall clock
 * on one stack this was hundreds of throws — a caller iterating rows, each
 * iteration re-entering a WASM instance that was already dead.
 *
 * ## The invariant that was missing
 *
 * **A trapped WASM instance never recovers.** An emscripten `abort()` /
 * `unreachable` / out-of-bounds trap leaves the module in a permanently faulted
 * state; every subsequent call into it traps identically. `isRecoverableOpenError`
 * has encoded that for *open* failures since HS-8426 — but a trap on a LIVE query
 * fell through every branch of the query proxy's catch and simply propagated, so
 * the handle stayed in the `databases` map and the next call went straight back
 * in.
 *
 * ## What this does and does not fix
 *
 * Poisoning does NOT stop a caller's loop — the caller decides how many rows it
 * iterates. It makes each iteration fail *immediately and cheaply*, from a plain
 * pre-built Error raised in JS, instead of re-entering WASM and paying a fresh
 * trap plus a deoptimizing stack walk. That is the difference between a wedged
 * event loop and a failed request, which is the outcome worth having.
 *
 * Deliberately NOT matched here: `PGlite is closed` (a pre-flight check on a
 * healthy instance — HS-9461 heals that by reopening) and the docs/73 storage
 * class (broken on disk, handled by `isClusterStorageFailure`). Both are
 * survivable in ways a trap is not.
 */

/** Substrings that identify a WASM-level trap in a thrown value's message. */
const TRAP_MARKERS = [
  // Emscripten's production abort path. PGLite builds with `-sASSERTIONS=0`, so
  // an internal Postgres assertion surfaces under this name.
  'Aborted',
  // `RuntimeError: unreachable` — the trap emitted by a compiled-in abort.
  'unreachable',
  'memory access out of bounds',
  'out of bounds memory access',
  // A failed `memory.grow` under pressure — the trap this incident most likely hit.
  'Cannot allocate Wasm memory',
  'WebAssembly.Memory',
  // Indirect-call trap from a corrupted table, seen in faulted modules.
  'null function or function signature mismatch',
];

/**
 * Has this cluster's WASM instance trapped?
 *
 * Matches on constructor name as well as message: V8 raises
 * `WebAssembly.RuntimeError`, whose `.name` is `RuntimeError` but whose message
 * is often just `unreachable` — message-only matching missed exactly that
 * variant in HS-7889, and the same trap reappeared here.
 *
 * Pure. Exported for the unit test.
 */
export function isWasmTrapError(err: unknown): boolean {
  if (err === null || err === undefined) return false;
  const name = err instanceof Error ? err.name : '';
  if (name === 'RuntimeError' || name === 'CompileError' || name === 'LinkError') return true;
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (message === '') return false;
  // `RuntimeError` can also arrive stringified inside a wrapper's message.
  if (message.includes('RuntimeError')) return true;
  return TRAP_MARKERS.some((marker) => message.includes(marker));
}

/**
 * The error a poisoned cluster raises instead of re-entering WASM.
 *
 * A distinct class so a caller can tell "this cluster is out of action" from
 * "this statement failed", and so the message names the real cause rather than
 * the tenth identical trap.
 *
 * `captureStackTrace` is skipped: the whole point is that this error is raised on
 * a hot failing path, possibly once per row, and stack capture is precisely what
 * pinned the loop. Its `stack` is set to the message alone.
 */
export class PoisonedClusterError extends Error {
  override readonly name = 'PoisonedClusterError';
  readonly dbPath: string;

  constructor(dbPath: string, cause?: unknown) {
    super(
      `PGLite cluster ${dbPath} is out of action: its WASM instance trapped and cannot be reused. `
      + 'It will be reopened after a short cooldown (HS-9554, docs/128).',
      cause === undefined ? undefined : { cause },
    );
    this.dbPath = dbPath;
    this.stack = `${this.name}: ${this.message}`;
  }
}

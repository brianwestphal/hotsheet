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

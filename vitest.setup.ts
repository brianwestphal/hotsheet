/**
 * HS-9449 — install kerf's development diagnostics for the unit suite.
 *
 * kerf 3.0 stopped inferring dev mode: without an explicit `import 'kerfjs/dev'`
 * every consumer gets the PRODUCTION shape. For the browser bundle that is exactly
 * what we want (the diagnostics never actually ran in a browser before 3.0 — they
 * read `globalThis.process.env` — and leaving them out sheds ~4.7 KB min+gzip). But
 * it silently removed a guard we HAD been relying on: in dev mode `defineStore`'s
 * `get()` returned a deep read-only proxy, so mutating a store snapshot threw a
 * `TypeError` instead of quietly desyncing every reactive consumer. That guard was
 * the stated safety net when the store consumers were audited (HS-8444).
 *
 * Tests are where it can still catch something, and they run in Node where kerf's
 * diagnostics work. So: production stays lean, the suite keeps the net.
 *
 * This must be the FIRST import — kerf picks a signal's machinery when the signal is
 * CREATED, so module-scope signals in modules imported before this one are outside
 * the diagnostics' coverage. A setup file runs before the test module graph loads,
 * which is the earliest hook available.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enableWarnings } from 'kerfjs/dev';

enableWarnings({
  // Hot Sheet's own surface: stores + `morph()` + `delegate()`. We don't use kerf's
  // `mount()`/`each()`, so the list-reconcile diagnostics have nothing to report —
  // `invariants` is on anyway because it costs nothing when no list exists and would
  // catch a kerf-side regression at the render that caused it.
  invariants: 'throw',
  delegateInEffect: true,
  narrowSet: true,
  // HS-9373 — added with the kerf 4.1 bump. Both are aimed squarely at how Hot
  // Sheet renders (fine-grained bindings over a `morph()`ed subtree):
  //   `staleBinding`      — a binding left reading a replaced node on the
  //                         byte-equal fast path, which shows up as a value that
  //                         silently stops updating.
  //   `valueOnlyRerender` — a re-render whose only changes could have been
  //                         fine-grained bindings, i.e. wasted reconciliation.
  // Both are silent across the current suite; they are on so that a regression
  // is reported at the render that caused it rather than found later by hand.
  staleBinding: true,
  valueOnlyRerender: true,
});

/**
 * HS-9531 — keep the suite out of the maintainer's real `~/.hotsheet`.
 *
 * Diagnostics moved from per-project `<dataDir>/freeze.log` to ONE process-wide
 * log under `globalHotsheetDir()`. That directory honors `HOTSHEET_HOME` (docs/87),
 * and nothing was setting it for unit tests — so without this, every `vitest` run
 * would append its heartbeat and instrumentation entries to the live file the
 * maintainer actually reads when diagnosing a wedge, and `_resetForTesting` would
 * not undo it.
 *
 * Set unconditionally rather than only-if-unset: a stray `HOTSHEET_HOME` in the
 * developer's shell would otherwise silently redirect the suite at a real
 * directory, which is the same hazard wearing a different hat.
 *
 * Consequence worth knowing: `globalHotsheetDir()` checks `HOTSHEET_HOME` BEFORE
 * `homedir()`, so seven suites that isolate themselves by MOCKING `homedir` now
 * `delete process.env.HOTSHEET_HOME` at their top (instance, global-config,
 * project-list, secret-keys, startup-log, cli.migrateGlobalConfig,
 * plugins/loader). They were implicitly relying on the variable being unset;
 * that assumption is now written down where it is relied on.
 *
 * `global-dir.e2e.test.ts` is unaffected — it passes an explicit value to the
 * child process it spawns.
 */
process.env.HOTSHEET_HOME = mkdtempSync(join(tmpdir(), 'hs-vitest-home-'));

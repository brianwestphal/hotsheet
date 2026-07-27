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
import { enableWarnings } from 'kerfjs/dev';

enableWarnings({
  // Hot Sheet's own surface: stores + `morph()` + `delegate()`. We don't use kerf's
  // `mount()`/`each()`, so the list-reconcile diagnostics have nothing to report —
  // `invariants` is on anyway because it costs nothing when no list exists and would
  // catch a kerf-side regression at the render that caused it.
  invariants: 'throw',
  delegateInEffect: true,
  narrowSet: true,
});

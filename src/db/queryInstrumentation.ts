/**
 * HS-9239 — name the PGLite event-loop blocks in `freeze.log`.
 *
 * PGLite is WASM and executes `query` / `exec` / `dumpDataDir` **synchronously
 * on the Node event loop**. A slow one IS an event-loop block — but before this
 * the heartbeat (`freezeLogger`) could only record that the loop was "blocked",
 * never WHICH statement did it. The big uninstrumented `server-heartbeat` gaps
 * in a freeze capture (e.g. an 899 ms block on tab-switch with no adjacent
 * `server-instrument-*` label) were almost always PGLite reads — invisible.
 *
 * This wraps a PGLite instance in a Proxy that times `query` / `exec` /
 * `dumpDataDir` via `instrumentAsync`, so any call past the freeze threshold
 * lands in `<dataDir>/freeze.log` WITH a truncated, single-line SQL label
 * (`pglite.query: SELECT … FROM tickets …`). Overhead is one `hrtime` pair per
 * call; it only writes when a call is genuinely slow.
 *
 * Proxy correctness notes:
 * - PGLite uses private class fields, which a Proxy does NOT forward — so every
 *   method is `.bind(target)` (and `query`/`exec`/`dumpDataDir` `.call(target,…)`)
 *   so `this` is the REAL instance, never the proxy. Property reads also use
 *   `target` as the getter receiver for the same reason.
 * - Only the three heavy DB methods are timed; everything else (`transaction`,
 *   `listen`, `waitReady`, `close`, …) passes straight through.
 *
 * Disable the FREEZE TIMING with `HOTSHEET_DISABLE_QUERY_INSTRUMENTATION=1`
 * (escape hatch if the timing wrapper is ever suspected). HS-9420 note: the
 * proxy is now ALWAYS applied even when timing is disabled, because it also
 * tracks in-flight queries for the cluster-eviction safety invariant (a cluster
 * with an in-flight query is never evicted). The env var only skips the
 * freeze-log timing (`instrumentAsync` + label building), not the proxy itself.
 */

import { type PGlite } from '@electric-sql/pglite';
import { dirname } from 'path';

import { instrumentAsync } from '../diagnostics/freezeLogger.js';
import { beginClusterQuery, endClusterQuery } from './clusterEviction.js';

/** Methods whose wall-clock we time (the ones that run WASM on the loop). */
const TIMED_METHODS = new Set(['query', 'exec', 'dumpDataDir']);

/** Build a compact, single-line freeze.log label from a method + its first arg
 *  (the SQL for query/exec; absent for dumpDataDir). Capped so a huge statement
 *  doesn't bloat the log line. */
function methodLabel(method: string, firstArg: unknown): string {
  if (typeof firstArg !== 'string' || firstArg === '') return `pglite.${method}`;
  const oneLine = firstArg.replace(/\s+/g, ' ').trim();
  return `pglite.${method}: ${oneLine.slice(0, 140)}`;
}

/** True unless explicitly disabled via env. */
export function isQueryInstrumentationEnabled(): boolean {
  const v = process.env.HOTSHEET_DISABLE_QUERY_INSTRUMENTATION;
  return v === undefined || v === '' || v === '0' || v === 'false';
}

/**
 * Wrap `db` so its heavy methods (a) track in-flight query count for the
 * HS-9420 eviction safety invariant and (b) log to `<dataDir>/freeze.log` when
 * slow. `dbPath` is `<dataDir>/db`, so the dataDir is its parent. The proxy is
 * ALWAYS applied; `HOTSHEET_DISABLE_QUERY_INSTRUMENTATION=1` only skips the
 * freeze-timing wrapper (the in-flight tracking always runs — eviction
 * correctness must not depend on an env flag).
 */
export function instrumentDbQueries(db: PGlite, dbPath: string): PGlite {
  const timingEnabled = isQueryInstrumentationEnabled();
  const dataDir = dirname(dbPath);
  return new Proxy(db, {
    get(target, prop) {
      // Read the property off the REAL target (private-field-safe getters).
      const value = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      if (typeof prop === 'string' && TIMED_METHODS.has(prop)) {
        return (...args: unknown[]): unknown => {
          // Count this query as in-flight for the whole call so a concurrent
          // eviction can't close the cluster mid-query. `endClusterQuery` runs
          // on both resolve and reject.
          beginClusterQuery(dbPath);
          const settle = <T>(p: Promise<T>): Promise<T> => {
            const done = (): void => endClusterQuery(dbPath);
            p.then(done, done);
            return p;
          };
          try {
            const run = (): Promise<unknown> => Promise.resolve(fn.call(target, ...args));
            const result = timingEnabled
              ? instrumentAsync(dataDir, methodLabel(prop, args[0]), run)
              : run();
            return settle(result);
          } catch (err) {
            // Synchronous throw before a promise existed — release immediately.
            endClusterQuery(dbPath);
            throw err;
          }
        };
      }
      // Everything else: bind to the real instance so private fields resolve.
      return fn.bind(target);
    },
  });
}

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
import { isClusterStorageFailure } from './storageFailure.js';

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
 * HS-9461 — did this query fail because its PGLite instance is already closed?
 *
 * PGLite's `_checkReady` throws `PGlite is closed` / `PGlite is closing` as a
 * PRE-FLIGHT check, before the statement runs. That detail is what makes the
 * retry below safe: a query that fails this way provably did not partially
 * apply, so re-running it on a fresh instance cannot double-write.
 *
 * Pure: takes only the thrown value. Exported for the unit test.
 */
export function isClosedInstanceError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  return message.includes('PGlite is closed') || message.includes('PGlite is closing');
}

/**
 * Reopen an evicted cluster so a stale handle can heal. Injected by
 * `connection.ts` (which owns the `databases` map) to avoid a static
 * `queryInstrumentation → connection` cycle — connection.ts already imports
 * this module. Returns the fresh instance, or null when healing is NOT
 * appropriate (shutdown in progress, or the cluster was closed deliberately
 * rather than evicted).
 */
type ClusterReopener = (dbPath: string) => Promise<PGlite | null>;
let reopenCluster: ClusterReopener | null = null;

/** Register the reopener. Called once by `connection.ts` at module init. */
export function setClusterReopener(fn: ClusterReopener | null): void {
  reopenCluster = fn;
}

/**
 * HS-9460 — notified when a LIVE query hits the storage-corruption class
 * (docs/73 §73.5.1: `xlog flush request … is not satisfied` and friends).
 *
 * Distinct from the reopener above, and deliberately NOT a retry: a closed
 * instance heals by reopening, but a cluster whose pages are ahead of its WAL is
 * broken on disk and will fail identically forever. All we can usefully do is
 * arrange for the next start to restore it, and make this session's error say
 * so. Injected by `connection.ts` for the same no-cycle reason as the reopener.
 */
type StorageFailureHandler = (dbPath: string, err: unknown) => void;
let onStorageFailure: StorageFailureHandler | null = null;

/** Register the storage-failure handler. Called once by `connection.ts`. */
export function setStorageFailureHandler(fn: StorageFailureHandler | null): void {
  onStorageFailure = fn;
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
            // HS-9461 — heal a query issued against an EVICTED cluster.
            //
            // The in-flight guard keeps a cluster alive for the duration of one
            // query, but callers hold a handle across many: `persistLogsPayload`
            // (an OTLP ingest) resolves `mainDb` once and then awaits a dozen
            // writes. In the gaps `inFlight` is 0, and the headroom guard
            // deliberately ignores the recency guard under memory pressure — so
            // it can close a cluster a live request is midway through using. The
            // next call on that now-stale handle threw `PGlite is closed`, which
            // surfaced to the user as the app going "disconnected".
            //
            // Reopen once and re-run on the fresh instance. Safe because the
            // error comes from a pre-flight check (see `isClosedInstanceError`)
            // and nothing in `src/` uses `db.transaction()`, so there is no
            // multi-statement unit a retry could tear. The reopener declines
            // during shutdown and for deliberately-closed clusters, so this can
            // never resurrect one we meant to close.
            return settle(result.catch(async (err: unknown) => {
              // HS-9460 — a live query hit the storage-corruption class. Not
              // retryable (the cluster is broken on disk, not merely closed), so
              // report it and let the error propagate; `connection.ts` arranges
              // for the next start to restore from snapshot.
              if (onStorageFailure !== null && isClusterStorageFailure(err)) {
                onStorageFailure(dbPath, err);
                throw err;
              }
              if (!isClosedInstanceError(err) || reopenCluster === null) throw err;
              const fresh = await reopenCluster(dbPath);
              if (fresh === null) throw err;
              const method = (fresh as unknown as Record<string, unknown>)[prop];
              if (typeof method !== 'function') throw err;
              console.error(`[db] reopened evicted cluster ${dbPath} to retry a ${prop} from a stale handle.`);
              return await (method as (...a: unknown[]) => Promise<unknown>).call(fresh, ...args);
            }));
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

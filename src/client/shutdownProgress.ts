/**
 * HS-8911 — map the sidecar's internal `gracefulShutdown` step labels (emitted
 * as `[lifecycle:progress] <label>` on stdout, see `src/lifecycle.ts`) to the
 * short, user-facing phrases the desktop "Shutting Down" overlay shows.
 *
 * Per the HS-8911 design decision (option **b**): the overlay names the current
 * step rather than a percentage — snapshot + DB-close dominate and vary, so a %
 * would be misleading. Several trailing, near-instant steps collapse to a single
 * "Finishing up…" so the overlay doesn't flicker through them. An unknown label
 * falls back to the generic phrase (forward-compatible if steps are renamed /
 * added — the overlay still reads sensibly).
 *
 * Pure + dependency-free so it unit-tests directly; the overlay rendering and
 * the Tauri `shutdown-progress` event wiring live separately.
 */

/** Internal step label → user-facing phrase. Keys mirror the `runStep(label, …)`
 *  calls in `src/lifecycle.ts::runShutdownPipeline`. */
const SHUTDOWN_STEP_PHRASES: Record<string, string> = {
  closeHttpServer: 'Closing the server…',
  killShellCommands: 'Stopping shell commands…',
  destroyTerminals: 'Closing terminals…',
  disposeGitWatchers: 'Stopping file watchers…',
  terminateHashWorker: 'Stopping background workers…',
  snapshotDatabases: 'Saving a snapshot of your data…',
  closeDatabases: 'Closing databases…',
  // Fast trailing bookkeeping steps — collapse to one calm phrase.
  stopFreezeHeartbeat: 'Finishing up…',
  stopTelemetryRetentionTimer: 'Finishing up…',
  releaseProjectLocks: 'Finishing up…',
  removeLockfile: 'Finishing up…',
};

/** The generic phrase shown before the first step lands or for an unknown step. */
export const SHUTDOWN_DEFAULT_PHRASE = 'Shutting down…';

/** Friendly phrase for an internal step label. Unknown / empty → the default. */
export function friendlyShutdownLabel(internalLabel: string): string {
  return SHUTDOWN_STEP_PHRASES[internalLabel] ?? SHUTDOWN_DEFAULT_PHRASE;
}

/** Parse a sidecar stdout line for the HS-8911 progress marker; returns the
 *  internal step label, or null if the line isn't a progress marker. Exported so
 *  the (eventual) Tauri-side parser and tests share one definition of the
 *  contract `[lifecycle:progress] <label>`. */
export function parseShutdownProgressLine(line: string): string | null {
  const m = /^\[lifecycle:progress\] (.+)$/.exec(line.trim());
  return m ? m[1].trim() : null;
}

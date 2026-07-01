/**
 * HS-9236 (epic HS-9226, Phase 3) — rotating, time-partitioned JSONL store for
 * RAW OTLP rows.
 *
 * Phase 1+2 moved the dashboards off raw `otel_*` onto the compact rollups
 * (HS-9235/9257), so raw telemetry is now needed only by the deep §68 inspectors
 * (span tree / event list / prompt timeline). This module writes each raw row to
 * a day-partitioned JSONL file so the raw data can leave the PGLite cluster
 * entirely (Phase 3 drops the raw tables in HS-9237), keeping the snapshotted DB
 * small — the whole point of the epic.
 *
 * Design (mirrors `diagnostics/freezeLogger.ts::appendFreezeLog`):
 *   - Files live at `<telemetryDir>/otel-<kind>-YYYY-MM-DD.jsonl` — OUTSIDE the
 *     `<telemetryDir>/db` cluster, so they're never snapshotted (§73) or backed
 *     up (§7); both dump `db/` only. `<telemetryDir>` is `telemetryClusterDataDir`
 *     (a project's `<dataDir>/telemetry`, or the central `~/.hotsheet/telemetry`).
 *   - Append is a per-FILE single-flight Promise chain, so concurrent writes to
 *     the same day's file never interleave bytes mid-line. Different days/kinds
 *     have independent chains.
 *   - The filename IS the time index ("not indexed is OK", ticket) — an inspector
 *     opens only the relevant day's file. The day is the SERVER-LOCAL calendar day
 *     (`serverLocalDay`), matching the rollup grain used everywhere else.
 *   - Reads are crash-tolerant: a torn/unparseable last line (unclean shutdown
 *     mid-append) is skipped, not fatal.
 *   - A sweeper age-deletes files older than N days.
 *
 * Best-effort throughout: a write failure is swallowed (logged) so it never
 * cascades into the OTLP ingest hot path — the same contract freeze.log uses.
 */

import { promises as fsp } from 'fs';
import { join } from 'path';

import { serverLocalDay } from './otelRollupIngest.js';

/** The three raw OTLP row families, each its own daily file. */
export type OtelJsonlKind = 'events' | 'metrics' | 'spans';

const DAY_RE = /^otel-(events|metrics|spans)-(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** `<telemetryDir>/otel-<kind>-<YYYY-MM-DD>.jsonl`. */
export function otelJsonlPath(telemetryDir: string, kind: OtelJsonlKind, day: string): string {
  return join(telemetryDir, `otel-${kind}-${day}.jsonl`);
}

/** Per-file single-flight append chain (keyed by full path). */
const appendChains = new Map<string, Promise<void>>();

/**
 * Append one raw row as a JSONL line to the day-file for `ts` (server-local day).
 * Serialized per file so concurrent appends can't interleave. Resolves once the
 * bytes hit the OS buffer (no fsync — raw telemetry can lose its tail on an
 * unclean shutdown; the reader skips a torn last line). Errors are swallowed.
 */
export function appendOtelJsonl(
  telemetryDir: string,
  kind: OtelJsonlKind,
  ts: Date,
  record: Record<string, unknown>,
): Promise<void> {
  const path = otelJsonlPath(telemetryDir, kind, serverLocalDay(ts));
  const prev = appendChains.get(path) ?? Promise.resolve();
  const next = prev
    .catch(() => { /* drop chained errors so one bad write doesn't poison the file's queue */ })
    .then(async () => {
      try {
        // Serialize INSIDE the chain so a JSON.stringify failure (e.g. a BigInt)
        // is swallowed here, never thrown into the OTLP ingest hot path.
        const line = JSON.stringify(record) + '\n';
        await fsp.mkdir(telemetryDir, { recursive: true });
        await fsp.appendFile(path, line, 'utf8');
      } catch (err) {
        console.warn('[otel-jsonl] append failed:', err instanceof Error ? err.message : String(err));
      }
    });
  appendChains.set(path, next);
  return next;
}

/**
 * Read all rows from one day's file, crash-tolerant: blank lines and any line
 * that fails to JSON-parse (e.g. a torn final line from an unclean shutdown mid-
 * append) are skipped rather than throwing. Returns `[]` when the file is absent.
 */
export async function readOtelJsonlDay(
  telemetryDir: string,
  kind: OtelJsonlKind,
  day: string,
): Promise<Record<string, unknown>[]> {
  let content: string;
  try {
    content = await fsp.readFile(otelJsonlPath(telemetryDir, kind, day), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const out: Record<string, unknown>[] = [];
  for (const line of content.split('\n')) {
    if (line === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        out.push(parsed as Record<string, unknown>);
      }
    } catch { /* torn / malformed line — skip (crash tolerance) */ }
  }
  return out;
}

/** The `YYYY-MM-DD` day this file is partitioned by, or null if the name doesn't
 *  match the pattern. Exported (pure) for the sweeper + tests. */
export function jsonlFileDay(filename: string): string | null {
  const m = DAY_RE.exec(filename);
  return m ? m[2] : null;
}

/**
 * Delete `otel-*-<day>.jsonl` files whose day is more than `maxAgeDays` before
 * `now` (server-local). Returns the number of files removed. Best-effort: an
 * unreadable dir or a failed unlink is swallowed. `maxAgeDays <= 0` disables the
 * sweep (keep forever) — matches the retention-config convention. `kinds`, when
 * given, restricts the sweep to those row families (so events/metrics can age at
 * a different window than the higher-volume spans, mirroring the raw retention).
 */
export async function sweepOtelJsonl(
  telemetryDir: string,
  maxAgeDays: number,
  now: Date = new Date(),
  kinds?: readonly OtelJsonlKind[],
): Promise<number> {
  if (maxAgeDays <= 0) return 0;
  let names: string[];
  try {
    names = await fsp.readdir(telemetryDir);
  } catch {
    return 0; // dir doesn't exist yet / unreadable — nothing to sweep
  }
  const kindSet = kinds === undefined ? null : new Set<string>(kinds);
  // Cutoff = the earliest day to KEEP (server-local midnight, maxAgeDays back).
  const cutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate() - maxAgeDays);
  const cutoffDay = serverLocalDay(cutoff);
  let removed = 0;
  for (const name of names) {
    const m = DAY_RE.exec(name);
    if (m === null) continue;
    if (kindSet !== null && !kindSet.has(m[1])) continue;
    if (m[2] >= cutoffDay) continue; // lexicographic works for YYYY-MM-DD
    try {
      await fsp.unlink(join(telemetryDir, name));
      removed++;
    } catch { /* raced deletion / perms — skip */ }
  }
  return removed;
}

/** Test-only — drop the per-file append chains so tests don't bleed. */
export function _resetOtelJsonlForTesting(): void {
  appendChains.clear();
}

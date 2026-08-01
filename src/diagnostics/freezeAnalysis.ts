/**
 * HS-9531 — answer "what blocked the event loop, ranked, over window W".
 *
 * ## Why this is a module and not a paragraph in a ticket
 *
 * The HS-9521 investigation wrote this logic three times as throwaway JS, and got
 * it wrong the first two: once by summing `instrumentAsync` WALL durations as if
 * they were blocked time (reporting ~10 % of the loop blocked when the real figure
 * was 2.88 %), and once by correlating the heartbeat against a single project's
 * log while nine projects shared the loop (reporting 65 % of blocking as
 * "attributable to nothing" when two-thirds of it was in the other eight files).
 *
 * Both mistakes are now structurally harder to make — one log (HS-9531) and a
 * `blocking` flag on every entry — but the aggregation still has to be written
 * somewhere, and a shared, tested implementation beats each investigator
 * re-deriving it under time pressure while a server is down.
 *
 * Everything here is PURE over an array of entries. Reading the file is the
 * caller's problem, which is what makes it testable without a filesystem.
 */

import type { FreezeEntry } from './freezeLogger.js';

/** An entry whose `durationMs` is genuinely time the loop could not run. */
export function isBlocking(entry: FreezeEntry): boolean {
  // Explicit flag wins. Fall back to the SOURCE for entries written before
  // HS-9531 added the field, so an existing log still analyzes correctly rather
  // than silently reporting zero blocking.
  if (typeof entry.blocking === 'boolean') return entry.blocking;
  return entry.source === 'server-heartbeat'
    || entry.source === 'server-instrument-sync'
    // HS-9534 — a stop-the-world collection genuinely stops the loop.
    || entry.source === 'server-gc';
}

/**
 * HS-9528 — fraction of a span's wall time that was actually CPU work.
 *
 * Returns null when `cpuMs` is absent (entries written before the field existed).
 */
export function cpuRatio(entry: FreezeEntry): number | null {
  if (typeof entry.cpuMs !== 'number' || entry.durationMs <= 0) return null;
  return entry.cpuMs / entry.durationMs;
}

/** Below this share of CPU, a long span is elapsed time rather than work. */
export const SUSPECT_SUSPEND_CPU_RATIO = 0.05;

/**
 * Did this entry spend a long time consuming almost no CPU?
 *
 * That is the signature of a machine that slept mid-operation — the case that
 * made a 17-minute `VACUUM` look like seventeen minutes of wedged server when a
 * standalone run of the same VACUUM on the same 142 MB cluster takes 100 ms.
 *
 * It cannot be answered by the clocks: measured 2026-07-31, `hrtime.bigint()`
 * advances during sleep on this platform (171 h uptime across 743 sleep events,
 * agreeing with wall-clock uptime to 0.00 h), so HS-9520's divergence test sees
 * ~0 and reports a block.
 *
 * Deliberately conservative: only flags spans long enough that near-zero CPU is
 * unambiguous. A short span can legitimately be I/O-bound.
 */
export function looksLikeSuspend(entry: FreezeEntry): boolean {
  if (entry.durationMs < 10_000) return false;
  const ratio = cpuRatio(entry);
  return ratio !== null && ratio < SUSPECT_SUSPEND_CPU_RATIO;
}

export interface Window {
  fromMs: number;
  toMs: number;
}

/** Parse JSONL, skipping anything unparseable. A truncated tail is normal — the
 *  file is appended to live and rotated under a cap. */
export function parseFreezeLog(raw: string): FreezeEntry[] {
  const out: FreezeEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line === '') continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null && 'ts' in parsed) {
        out.push(parsed as FreezeEntry);
      }
    } catch {
      // A partially-written last line, or a rotation boundary.
    }
  }
  return out;
}

/** The time span an entry covers: `ts` marks the END (detection is after the
 *  fact), so the interval runs backwards from it. */
export function intervalOf(entry: FreezeEntry): [number, number] {
  const end = Date.parse(entry.ts);
  return [end - entry.durationMs, end];
}

export function inWindow(entry: FreezeEntry, window: Window | null): boolean {
  if (window === null) return true;
  const end = Date.parse(entry.ts);
  return end >= window.fromMs && end <= window.toMs;
}

export interface BlockingSummary {
  /** Total ms the loop was observably blocked. */
  blockedMs: number;
  /** Share of the observed window, 0..1. */
  blockedRatio: number;
  worstMs: number;
  count: number;
  windowMs: number;
}

/**
 * Ground truth for "how much was the loop actually blocked".
 *
 * Counts ONLY `blocking` entries, and only heartbeat ones at that — the heartbeat
 * measures an inter-tick gap, so its entries are non-overlapping observations of
 * the loop itself. Adding `instrument-sync` here would double-count: a sync block
 * shows up in BOTH its own entry and the heartbeat gap it causes.
 */
export function summarizeBlocking(entries: FreezeEntry[], window: Window | null = null): BlockingSummary {
  const beats = entries.filter(e => e.source === 'server-heartbeat' && inWindow(e, window));
  const blockedMs = beats.reduce((a, e) => a + e.durationMs, 0);
  const stamps = entries.filter(e => inWindow(e, window)).map(e => Date.parse(e.ts));
  const windowMs = window !== null
    ? window.toMs - window.fromMs
    : (stamps.length > 1 ? Math.max(...stamps) - Math.min(...stamps) : 0);
  return {
    blockedMs,
    blockedRatio: windowMs > 0 ? blockedMs / windowMs : 0,
    worstMs: beats.reduce((a, e) => Math.max(a, e.durationMs), 0),
    count: beats.length,
    windowMs,
  };
}

export interface ContextStat {
  context: string;
  count: number;
  totalMs: number;
  worstMs: number;
  /** Distinct projects that produced this context — the HS-9529 multiplier. */
  projects: string[];
  blocking: boolean;
}

/**
 * Rank operations by cost, keeping blocking and wall-measured work in SEPARATE
 * rows even when they share a context name.
 *
 * The separation is the point: mixing them is what let a 773.6 s wall-time entry
 * (`fsyncDbDir`, which HS-8351 had already moved off-loop and which contributes
 * 0.5 s of real blocking) top the table and look like the thing to fix.
 */
export function rankByContext(entries: FreezeEntry[], window: Window | null = null): ContextStat[] {
  const byKey = new Map<string, ContextStat>();
  for (const e of entries) {
    if (!inWindow(e, window)) continue;
    if (e.source === 'server-memory' || e.source === 'freeze.log-truncated') continue;
    const blocking = isBlocking(e);
    const key = `${blocking ? 'B' : 'W'}\0${e.context}`;
    const stat = byKey.get(key) ?? {
      context: e.context, count: 0, totalMs: 0, worstMs: 0, projects: [], blocking,
    };
    stat.count += 1;
    stat.totalMs += e.durationMs;
    stat.worstMs = Math.max(stat.worstMs, e.durationMs);
    const project = e.project ?? '(unknown)';
    if (!stat.projects.includes(project)) stat.projects.push(project);
    byKey.set(key, stat);
  }
  return [...byKey.values()].sort((a, b) => b.totalMs - a.totalMs);
}

export interface Attribution {
  context: string;
  project: string;
  blocks: number;
  blockedMs: number;
}

export interface AttributionReport {
  attributed: Attribution[];
  attributedMs: number;
  unattributedMs: number;
  unattributedCount: number;
}

/**
 * Attribute each observed block to whatever instrumented operation was in flight
 * at the time.
 *
 * The heartbeat says WHEN the loop stalled; the instrumented spans say WHAT was
 * running. Overlap is the only link between them — no entry names its own cause.
 *
 * Credits the SHORTEST containing span, which is the most specific claim
 * available: a 5-minute backup train overlapping a 300 ms block says far less
 * than a 400 ms query overlapping the same block.
 */
export function attributeBlocks(entries: FreezeEntry[], window: Window | null = null): AttributionReport {
  const inWin = entries.filter(e => inWindow(e, window));
  const beats = inWin.filter(e => e.source === 'server-heartbeat');
  const spans = inWin
    .filter(e => e.source === 'server-instrument-async' || e.source === 'server-instrument-sync')
    .map(e => ({ entry: e, iv: intervalOf(e) }));

  const byKey = new Map<string, Attribution>();
  let attributedMs = 0;
  let unattributedMs = 0;
  let unattributedCount = 0;

  for (const beat of beats) {
    const [start, end] = intervalOf(beat);
    let best: { entry: FreezeEntry; iv: [number, number] } | null = null;
    for (const span of spans) {
      if (span.iv[0] > end || span.iv[1] < start) continue;
      if (best === null || (span.iv[1] - span.iv[0]) < (best.iv[1] - best.iv[0])) best = span;
    }
    if (best === null) {
      unattributedMs += beat.durationMs;
      unattributedCount += 1;
      continue;
    }
    attributedMs += beat.durationMs;
    const project = best.entry.project ?? '(unknown)';
    const key = `${best.entry.context}\0${project}`;
    const acc = byKey.get(key) ?? { context: best.entry.context, project, blocks: 0, blockedMs: 0 };
    acc.blocks += 1;
    acc.blockedMs += beat.durationMs;
    byKey.set(key, acc);
  }

  return {
    attributed: [...byKey.values()].sort((a, b) => b.blockedMs - a.blockedMs),
    attributedMs,
    unattributedMs,
    unattributedCount,
  };
}

/** Render the whole report as text — what the CLI prints. */
export function formatReport(entries: FreezeEntry[], window: Window | null = null): string {
  const s = summarizeBlocking(entries, window);
  const lines: string[] = [];
  const secs = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;

  lines.push(`window: ${(s.windowMs / 3_600_000).toFixed(2)} h, ${String(entries.length)} entries`);
  lines.push(
    `BLOCKED (heartbeat ground truth): ${secs(s.blockedMs)} across ${String(s.count)} blocks ` +
    `= ${(s.blockedRatio * 100).toFixed(2)}% of the window, worst ${String(s.worstMs)}ms`,
  );

  const ranked = rankByContext(entries, window);
  lines.push('', 'BLOCKING work (holds the loop):');
  for (const r of ranked.filter(x => x.blocking).slice(0, 15)) {
    lines.push(`  ${String(r.count).padStart(5)}x ${secs(r.totalMs).padStart(8)} worst=${String(r.worstMs)}ms  [${String(r.projects.length)}p]  ${r.context.slice(0, 70)}`);
  }
  lines.push('', 'WALL-measured spans (NOT blocked time — the loop runs during awaits):');
  for (const r of ranked.filter(x => !x.blocking).slice(0, 10)) {
    lines.push(`  ${String(r.count).padStart(5)}x ${secs(r.totalMs).padStart(8)} worst=${String(r.worstMs)}ms  [${String(r.projects.length)}p]  ${r.context.slice(0, 70)}`);
  }

  const suspects = entries.filter(e => inWindow(e, window)).filter(looksLikeSuspend);
  if (suspects.length > 0) {
    lines.push('', 'LONG spans that consumed almost NO CPU (a sleeping machine, not a wedge):');
    for (const e of suspects.slice(0, 10)) {
      lines.push(`  ${e.ts}  ${secs(e.durationMs)} wall, ${String(e.cpuMs ?? 0)}ms cpu  ${e.context.slice(0, 60)}`);
    }
  }

  const a = attributeBlocks(entries, window);
  lines.push('', 'Blocks attributed to a concurrent instrumented operation:');
  for (const r of a.attributed.slice(0, 15)) {
    lines.push(`  ${String(r.blocks).padStart(5)} blocks ${secs(r.blockedMs).padStart(8)}  ${r.context.slice(0, 60)} [${r.project}]`);
  }
  lines.push(
    `  attributed ${secs(a.attributedMs)}; UNATTRIBUTED ${secs(a.unattributedMs)} ` +
    `across ${String(a.unattributedCount)} blocks (nothing instrumented was running)`,
  );
  return lines.join('\n');
}

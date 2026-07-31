/**
 * HS-9531 — the process-wide diagnostics sink.
 *
 * These pin the two properties that make the switch worth making, and the one
 * that keeps it from being dangerous:
 *
 *  1. Every writer lands in ONE file, so correlating an effect with its cause is
 *     reading a single timeline instead of merging nine.
 *  2. The project is still recoverable, from the entry rather than from which
 *     file it happened to land in.
 *  3. `HOTSHEET_HOME` relocates it — without that, the test suite writes into the
 *     maintainer's live diagnostics log.
 */

import { mkdtempSync, promises as fsp, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DIAGNOSTICS_SUBDIR, diagnosticsDir, projectLabelForDataDir } from './diagnosticsDir.js';
import { _resetForTesting, appendFreezeLog, FREEZE_LOG_FILENAME } from './freezeLogger.js';

let home: string;
const originalHome = process.env.HOTSHEET_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hs-diagdir-'));
  process.env.HOTSHEET_HOME = home;
});

afterEach(() => {
  _resetForTesting();
  process.env.HOTSHEET_HOME = originalHome;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* */ }
});

const readLog = async (): Promise<Record<string, unknown>[]> => {
  const raw = await fsp.readFile(join(diagnosticsDir(), FREEZE_LOG_FILENAME), 'utf8');
  return raw.split('\n').filter(l => l !== '').map(l => JSON.parse(l) as Record<string, unknown>);
};

describe('diagnosticsDir', () => {
  it('lives under HOTSHEET_HOME, so the suite never touches the real ~/.hotsheet', () => {
    expect(diagnosticsDir()).toBe(join(home, DIAGNOSTICS_SUBDIR));
  });

  it('follows HOTSHEET_HOME when it changes, rather than caching the first answer', () => {
    const first = diagnosticsDir();
    const second = mkdtempSync(join(tmpdir(), 'hs-diagdir-2-'));
    process.env.HOTSHEET_HOME = second;
    try {
      expect(diagnosticsDir()).not.toBe(first);
      expect(diagnosticsDir()).toBe(join(second, DIAGNOSTICS_SUBDIR));
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  });
});

describe('projectLabelForDataDir', () => {
  it('names a project by its FOLDER, not the `.hotsheet` inside it', () => {
    expect(projectLabelForDataDir('/Users/x/Documents/kerf/.hotsheet')).toBe('kerf');
  });

  it('handles a trailing separator', () => {
    expect(projectLabelForDataDir('/Users/x/Documents/kerf/.hotsheet/')).toBe('kerf');
  });

  it('names the global telemetry dir usefully', () => {
    // This one mattered in practice: the 17-minute VACUUM (HS-9528) was recorded
    // against `~/.hotsheet/telemetry`, and a reader has to be able to tell it
    // apart from a project.
    expect(projectLabelForDataDir('/Users/x/.hotsheet/telemetry')).toBe('telemetry');
  });

  it('degrades to a label instead of throwing on empty input', () => {
    // The logger fires on paths that are ALREADY degraded. An unlabeled entry
    // beats a lost one.
    for (const bad of ['', '   ', null, undefined]) {
      expect(projectLabelForDataDir(bad)).toBe('(unknown)');
    }
  });
});

describe('one process-wide log (the HS-9531 fix)', () => {
  it('collects entries from DIFFERENT projects into a single file, tagged by project', async () => {
    // This is the whole point. Before, these two lines lived in two files: the
    // heartbeat's (one project, by HS-8674's single-attribution rule) and the
    // instrumentation's (its own project). Correlating them required knowing to
    // merge nine logs — which is exactly the step HS-9521 missed, reporting 65 %
    // of blocking as "caused by nothing instrumented" when two-thirds of it was
    // simply in the other eight files.
    await appendFreezeLog('/Users/x/Documents/kerf/.hotsheet', {
      ts: '2026-07-31T00:00:00.000Z', source: 'server-instrument-async',
      durationMs: 900, context: 'pglite.dumpDataDir: gzip', blocking: false,
    });
    await appendFreezeLog('/Users/x/Documents/hotsheet/.hotsheet', {
      ts: '2026-07-31T00:00:01.000Z', source: 'server-heartbeat',
      durationMs: 850, context: 'event-loop blocked', blocking: true,
    });

    const lines = await readLog();
    expect(lines).toHaveLength(2);
    expect(lines.map(l => l.project)).toEqual(['kerf', 'hotsheet']);
  });

  it('preserves an explicitly-supplied project rather than overwriting it', async () => {
    await appendFreezeLog('/Users/x/Documents/kerf/.hotsheet', {
      ts: '2026-07-31T00:00:00.000Z', source: 'client-heartbeat',
      durationMs: 120, context: 'ui', project: 'supplied-by-caller',
    });
    expect((await readLog())[0].project).toBe('supplied-by-caller');
  });

  it('does NOT write into the per-project dataDir any more', async () => {
    // The old location must go cold, or a reader keeps finding a stale file that
    // looks like a live one — the same trap as the orphaned backups in HS-9532.
    const projectDir = mkdtempSync(join(tmpdir(), 'hs-proj-'));
    try {
      await appendFreezeLog(projectDir, {
        ts: '2026-07-31T00:00:00.000Z', source: 'server-heartbeat',
        durationMs: 300, context: 'event-loop blocked',
      });
      await expect(fsp.access(join(projectDir, FREEZE_LOG_FILENAME))).rejects.toThrow();
      expect(await readLog()).toHaveLength(1);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('serialises interleaved writes from different projects without splicing lines', async () => {
    // The append queue used to be keyed by dataDir, which was safe only because
    // each dataDir owned its own file. With one shared file, per-dataDir chains
    // would let two projects interleave bytes mid-line — so this is a regression
    // test for the queue key, not just for concurrency in general.
    await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        appendFreezeLog(`/Users/x/Documents/p${String(i % 8)}/.hotsheet`, {
          ts: '2026-07-31T00:00:00.000Z', source: 'server-instrument-sync',
          durationMs: 100 + i, context: `op-${String(i)}`,
        })),
    );
    const lines = await readLog(); // JSON.parse throws on a spliced line
    expect(lines).toHaveLength(40);
    expect(new Set(lines.map(l => l.context)).size).toBe(40);
  });
});

describe('blocking vs wall time carried in the DATA (HS-9531)', () => {
  it('marks a synchronous block as blocking and an async span as not', async () => {
    // The distinction has to be a field, not a convention in whatever view
    // aggregates the log. HS-9521 summed async WALL times and concluded the loop
    // was blocked ~10 % of the time; the heartbeat's real figure was 2.88 %.
    await appendFreezeLog('/p/.hotsheet', {
      ts: '2026-07-31T00:00:00.000Z', source: 'server-instrument-sync',
      durationMs: 500, context: 'sync-op', blocking: true,
    });
    await appendFreezeLog('/p/.hotsheet', {
      ts: '2026-07-31T00:00:01.000Z', source: 'server-instrument-async',
      durationMs: 17_000, context: 'fsyncDbDir:backup:5min', blocking: false,
    });

    const lines = await readLog();
    const blockedMs = lines
      .filter(l => l.blocking === true)
      .reduce((a, l) => a + (l.durationMs as number), 0);

    // The 17 s async span is the LARGER number and contributes nothing to blocked
    // time — precisely the `fsyncDbDir` case that made the original analysis
    // nominate the one thing HS-8351 had already fixed.
    expect(blockedMs).toBe(500);
  });
});

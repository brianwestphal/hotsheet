/**
 * HS-8456 — verify the alive/dead transition tracker in `routes/channel.ts`:
 *   - first probe of a fresh tracker writes nothing (baseline, not a
 *     transition)
 *   - subsequent probe with the SAME value writes nothing (steady state —
 *     this is the anti-flood property since dashboard polls repeat on a
 *     fast cadence)
 *   - any subsequent probe with a DIFFERENT value writes one
 *     `channel-alive-transition` line with the prior → next text
 *   - the tracker is keyed per-dataDir, so two projects don't cross-flip
 *     each other
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _resetMainServerLoggersForTesting } from '../channelLog.js';
import { _resetChannelAliveTrackerForTesting, noteChannelAliveProbe } from './channel.js';

describe('noteChannelAliveProbe — alive/dead transition tracker (HS-8456)', () => {
  let dirA: string;
  let dirB: string;

  beforeEach(() => {
    dirA = mkdtempSync(join(tmpdir(), 'hotsheet-tracker-a-'));
    dirB = mkdtempSync(join(tmpdir(), 'hotsheet-tracker-b-'));
    _resetChannelAliveTrackerForTesting();
    _resetMainServerLoggersForTesting();
  });

  afterEach(() => {
    try { rmSync(dirA, { recursive: true, force: true }); } catch { /* ignore */ }
    try { rmSync(dirB, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function readLogOrEmpty(dataDir: string): string {
    try { return readFileSync(join(dataDir, 'mcp.log'), 'utf-8'); }
    catch { return ''; }
  }

  it('the first probe writes nothing — no prior value means no transition', () => {
    noteChannelAliveProbe(dirA, false);
    expect(readLogOrEmpty(dirA)).toBe('');
  });

  it('a repeat probe with the same value writes nothing (steady-state poll)', () => {
    noteChannelAliveProbe(dirA, true);
    noteChannelAliveProbe(dirA, true);
    noteChannelAliveProbe(dirA, true);
    expect(readLogOrEmpty(dirA)).toBe('');
  });

  it('a false → true transition writes one line', () => {
    noteChannelAliveProbe(dirA, false);
    noteChannelAliveProbe(dirA, true);
    const text = readLogOrEmpty(dirA);
    expect(text).toContain('channel-alive-transition: false → true');
    expect(text.split('\n').filter(l => l !== '')).toHaveLength(1);
  });

  it('a true → false transition writes one line (the disconnect signal)', () => {
    noteChannelAliveProbe(dirA, true);
    noteChannelAliveProbe(dirA, false);
    const text = readLogOrEmpty(dirA);
    expect(text).toContain('channel-alive-transition: true → false');
    expect(text.split('\n').filter(l => l !== '')).toHaveLength(1);
  });

  it('writes one line per flip — three transitions, three lines', () => {
    noteChannelAliveProbe(dirA, false);
    noteChannelAliveProbe(dirA, true);
    noteChannelAliveProbe(dirA, false);
    noteChannelAliveProbe(dirA, true);
    const lines = readLogOrEmpty(dirA).split('\n').filter(l => l !== '');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('false → true');
    expect(lines[1]).toContain('true → false');
    expect(lines[2]).toContain('false → true');
  });

  it('is keyed per-dataDir — two projects do not cross-flip each other', () => {
    noteChannelAliveProbe(dirA, true);
    noteChannelAliveProbe(dirB, false);
    // Each subsequent flip writes ONLY to that project's log.
    noteChannelAliveProbe(dirA, false);
    noteChannelAliveProbe(dirB, true);
    const linesA = readLogOrEmpty(dirA).split('\n').filter(l => l !== '');
    const linesB = readLogOrEmpty(dirB).split('\n').filter(l => l !== '');
    expect(linesA).toHaveLength(1);
    expect(linesA[0]).toContain('true → false');
    expect(linesB).toHaveLength(1);
    expect(linesB[0]).toContain('false → true');
  });

  it('lines tag the main-server pid label so cross-process correlation is unambiguous', () => {
    noteChannelAliveProbe(dirA, false);
    noteChannelAliveProbe(dirA, true);
    const text = readLogOrEmpty(dirA);
    expect(text).toMatch(new RegExp(`\\[pid ${process.pid} main\\] channel-alive-transition:`));
  });
});

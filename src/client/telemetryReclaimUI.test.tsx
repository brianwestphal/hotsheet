// @vitest-environment happy-dom
// HS-9427 — the pure post-reclaim status formatter.
import { describe, expect, it } from 'vitest';

import type { ReclaimWalResult } from '../api/index.js';
import { formatReclaimResult } from './telemetryReclaimUI.js';

const result = (over: Partial<ReclaimWalResult>): ReclaimWalResult =>
  ({ reclaimed: 0, skipped: 0, failed: 0, freedBytes: 0, results: [], ...over });

describe('formatReclaimResult (HS-9427)', () => {
  it('says nothing-to-reclaim when no cluster was over threshold', () => {
    expect(formatReclaimResult(result({ skipped: 5 }))).toContain('already compact');
  });

  it('reports freed MB + database count on success', () => {
    const msg = formatReclaimResult(result({ reclaimed: 3, freedBytes: 900 * 1024 * 1024 }));
    expect(msg).toContain('900 MB');
    expect(msg).toContain('3 databases');
  });

  it('uses the singular for one database', () => {
    const msg = formatReclaimResult(result({ reclaimed: 1, freedBytes: 300 * 1024 * 1024 }));
    expect(msg).toContain('1 database.');
    expect(msg).not.toContain('databases');
  });

  it('surfaces partial failures without hiding the reclaimed part', () => {
    const msg = formatReclaimResult(result({ reclaimed: 2, freedBytes: 400 * 1024 * 1024, failed: 1 }));
    expect(msg).toContain('400 MB');
    expect(msg).toContain('1 database could not be rebuilt');
  });

  it('reports an all-failed run as a failure message', () => {
    const msg = formatReclaimResult(result({ failed: 2 }));
    expect(msg).toContain('2 databases could not be rebuilt');
    expect(msg).not.toContain('Reclaimed');
  });
});

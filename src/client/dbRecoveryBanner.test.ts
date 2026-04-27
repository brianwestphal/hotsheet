import { describe, expect, it, vi } from 'vitest';

import { type DbRecoveryMarker, formatRecoveryBannerLabel } from './dbRecoveryBanner.js';

/**
 * HS-7899: the DB-recovery banner is the user's only signal that the
 * server fell through to renaming the live `db/` aside as
 * `db-corrupt-<ts>` and creating a fresh empty cluster. The label
 * formatter has to (a) say *when* it happened in human-friendly
 * relative time, (b) show enough of the underlying error for the user
 * to understand the cause, and (c) tell them that restoring from a
 * backup is the recovery path. These tests pin those contracts so the
 * label can't silently regress to the old "Database recovery occurred"
 * placeholder.
 */
describe('formatRecoveryBannerLabel (HS-7899)', () => {
  function marker(overrides: Partial<DbRecoveryMarker> = {}): DbRecoveryMarker {
    return {
      corruptPath: '/some/path/db-corrupt-1234',
      recoveredAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      errorMessage: 'Aborted(). Build with -sASSERTIONS for more info.',
      ...overrides,
    };
  }

  it('mentions the relative time, the error message, and how to recover', () => {
    const out = formatRecoveryBannerLabel(marker());
    expect(out).toMatch(/Database failed to load/);
    expect(out).toMatch(/30 minutes ago/);
    expect(out).toMatch(/Aborted\(\)/);
    expect(out).toMatch(/Restore from a backup/i);
  });

  it('uses "moments ago" for sub-minute recovery', () => {
    const fresh = marker({ recoveredAt: new Date(Date.now() - 5_000).toISOString() });
    expect(formatRecoveryBannerLabel(fresh)).toMatch(/moments ago/);
  });

  it('uses singular "1 minute ago" for exactly one minute', () => {
    const oneMin = marker({ recoveredAt: new Date(Date.now() - 60_000).toISOString() });
    expect(formatRecoveryBannerLabel(oneMin)).toMatch(/1 minute ago/);
  });

  it('uses hours when ≥ 60 minutes', () => {
    const twoHours = marker({ recoveredAt: new Date(Date.now() - 2 * 3_600_000).toISOString() });
    expect(formatRecoveryBannerLabel(twoHours)).toMatch(/2 hours ago/);
  });

  it('uses days when ≥ 24 hours', () => {
    const threeDays = marker({ recoveredAt: new Date(Date.now() - 3 * 86_400_000).toISOString() });
    expect(formatRecoveryBannerLabel(threeDays)).toMatch(/3 days ago/);
  });

  it('falls back to "recently" when the timestamp is unparseable', () => {
    const broken = marker({ recoveredAt: 'not-a-date' });
    expect(formatRecoveryBannerLabel(broken)).toMatch(/recently/);
  });

  it('omits the parenthetical when errorMessage is empty', () => {
    const noErr = marker({ errorMessage: '' });
    const out = formatRecoveryBannerLabel(noErr);
    expect(out).not.toMatch(/\(/);
    expect(out).toMatch(/and was reset to empty\. Restore/);
  });

  it('truncates an excessively long errorMessage so the banner stays single-line', () => {
    const long = marker({ errorMessage: 'X'.repeat(500) });
    const out = formatRecoveryBannerLabel(long);
    // truncate(text, 120) → at most 120 chars including the ellipsis
    expect(out.length).toBeLessThan(500);
    expect(out).toMatch(/X+…/);
  });
});

/** Sanity check: the module exports both the formatter and the entry
 *  point used by app.tsx. If either ever stops being a function the
 *  client boot sequence fails silently — these guards catch a
 *  refactor that accidentally drops one. */
describe('dbRecoveryBanner module surface', () => {
  it('exports formatRecoveryBannerLabel as a function', () => {
    expect(typeof formatRecoveryBannerLabel).toBe('function');
  });

  it('exports initDbRecoveryBanner as an async function', async () => {
    const mod = await import('./dbRecoveryBanner.js');
    expect(typeof mod.initDbRecoveryBanner).toBe('function');
  });
});

// Re-suppress unused-warnings for vi if it's not referenced.
void vi;

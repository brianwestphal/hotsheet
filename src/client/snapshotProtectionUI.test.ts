import { describe, expect, it } from 'vitest';

import { formatSnapshotStatusLine } from './snapshotProtectionUI.js';

/**
 * HS-8594: the Settings → Backups "Snapshot protection" status line is the
 * user's only confirmation that the §73 snapshot writer is actually
 * producing artifacts. `formatSnapshotStatusLine` shapes the
 * `{ lastSnapshotAt, lastSizeBytes }` payload from `GET /api/db/snapshot-status`
 * into "Last snapshot: HH:MM · N KB". These tests pin (a) the not-yet-written
 * sentinel, (b) the HH:MM + size shape, and (c) the size-unit thresholds so a
 * regression can't quietly print "00:00 · 0 B" before the first snapshot.
 */
describe('formatSnapshotStatusLine (HS-8594)', () => {
  it('reports the not-yet-snapshotted state when lastSnapshotAt is null', () => {
    const out = formatSnapshotStatusLine({ lastSnapshotAt: null, lastSizeBytes: null });
    expect(out).toMatch(/no snapshot taken yet/i);
    // Must NOT render a bogus time/size.
    expect(out).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it('renders "Last snapshot: HH:MM · N KB" with a localized time + KB size', () => {
    const at = new Date('2026-05-25T14:37:00').getTime();
    const out = formatSnapshotStatusLine({ lastSnapshotAt: at, lastSizeBytes: 48 * 1024 });
    expect(out).toMatch(/^Last snapshot: /);
    // Localized HH:MM (locale-independent digit/colon shape).
    expect(out).toMatch(/\d{1,2}:\d{2}/);
    expect(out).toContain('48 KB');
    expect(out).toContain('·');
  });

  it('formats sub-KB sizes in bytes', () => {
    const out = formatSnapshotStatusLine({ lastSnapshotAt: Date.now(), lastSizeBytes: 512 });
    expect(out).toContain('512 B');
  });

  it('formats MB-scale sizes with one decimal', () => {
    const out = formatSnapshotStatusLine({ lastSnapshotAt: Date.now(), lastSizeBytes: 3 * 1024 * 1024 + 512 * 1024 });
    expect(out).toContain('3.5 MB');
  });

  it('rounds KB sizes to a whole number', () => {
    const out = formatSnapshotStatusLine({ lastSnapshotAt: Date.now(), lastSizeBytes: 1536 });
    expect(out).toContain('2 KB');
  });

  it('omits the size when lastSizeBytes is null but a time exists', () => {
    const out = formatSnapshotStatusLine({ lastSnapshotAt: Date.now(), lastSizeBytes: null });
    expect(out).toMatch(/^Last snapshot: /);
    expect(out).not.toContain('·');
  });
});

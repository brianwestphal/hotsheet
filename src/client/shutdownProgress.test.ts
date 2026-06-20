/**
 * HS-8911 — friendly shutdown-step labels + progress-marker parsing.
 */
import { describe, expect, it } from 'vitest';

import { friendlyShutdownLabel, parseShutdownProgressLine, SHUTDOWN_DEFAULT_PHRASE } from './shutdownProgress.js';

describe('friendlyShutdownLabel (HS-8911)', () => {
  it('maps the slow, user-meaningful steps to clear phrases', () => {
    expect(friendlyShutdownLabel('snapshotDatabases')).toBe('Saving a snapshot of your data…');
    expect(friendlyShutdownLabel('closeDatabases')).toBe('Closing databases…');
    expect(friendlyShutdownLabel('destroyTerminals')).toBe('Closing terminals…');
  });

  it('collapses the fast trailing bookkeeping steps to one calm phrase', () => {
    for (const s of ['stopFreezeHeartbeat', 'stopTelemetryRetentionTimer', 'releaseProjectLocks', 'removeLockfile']) {
      expect(friendlyShutdownLabel(s)).toBe('Finishing up…');
    }
  });

  it('falls back to the default phrase for unknown / empty labels', () => {
    expect(friendlyShutdownLabel('somethingNew')).toBe(SHUTDOWN_DEFAULT_PHRASE);
    expect(friendlyShutdownLabel('')).toBe(SHUTDOWN_DEFAULT_PHRASE);
  });
});

describe('parseShutdownProgressLine (HS-8911)', () => {
  it('extracts the internal label from a progress marker line', () => {
    expect(parseShutdownProgressLine('[lifecycle:progress] snapshotDatabases')).toBe('snapshotDatabases');
    expect(parseShutdownProgressLine('  [lifecycle:progress] closeDatabases  ')).toBe('closeDatabases');
  });

  it('returns null for non-marker lines', () => {
    expect(parseShutdownProgressLine('[lifecycle] step "snapshotDatabases" — starting')).toBeNull();
    expect(parseShutdownProgressLine('some other log line')).toBeNull();
    expect(parseShutdownProgressLine('')).toBeNull();
  });
});

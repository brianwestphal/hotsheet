import { describe, expect, it } from 'vitest';

import { formatBackupErrorMessage } from './backups.js';

/**
 * HS-7890: backup UI catch-blocks must show the real underlying error,
 * not a generic "Restore failed" / "Failed to load backup preview".
 * `api()` rejects with `new Error(serverErrorMessage)`, so the helper has
 * to flatten that into a single label string the UI can drop in.
 */
describe('formatBackupErrorMessage (HS-7890)', () => {
  it('appends the real Error message to the prefix', () => {
    const err = new Error('PANIC: could not locate a valid checkpoint record at 0/7A58678');
    expect(formatBackupErrorMessage('Restore failed', err)).toBe(
      'Restore failed: PANIC: could not locate a valid checkpoint record at 0/7A58678'
    );
  });

  it('preserves the underlying message verbatim — no truncation', () => {
    const long = 'a'.repeat(500);
    const err = new Error(long);
    const out = formatBackupErrorMessage('Restore failed', err);
    expect(out).toContain(long);
  });

  it('falls back to "Unknown error" when the throw is not an Error', () => {
    expect(formatBackupErrorMessage('Restore failed', 'oops string')).toBe('Restore failed: Unknown error');
    expect(formatBackupErrorMessage('Restore failed', null)).toBe('Restore failed: Unknown error');
    expect(formatBackupErrorMessage('Restore failed', undefined)).toBe('Restore failed: Unknown error');
  });

  it('falls back to "Unknown error" for an Error with an empty message', () => {
    // Defensive — would otherwise produce "Restore failed: " with a
    // dangling colon, which looks like a UI bug.
    expect(formatBackupErrorMessage('Restore failed', new Error(''))).toBe(
      'Restore failed: Unknown error'
    );
  });

  it('uses the provided prefix verbatim — different call sites use different prefixes', () => {
    const err = new Error('Backup file not found');
    expect(formatBackupErrorMessage('Failed to load backup preview', err)).toBe(
      'Failed to load backup preview: Backup file not found'
    );
    expect(formatBackupErrorMessage('Failed to load backups', err)).toBe(
      'Failed to load backups: Backup file not found'
    );
    expect(formatBackupErrorMessage('Failed', err)).toBe('Failed: Backup file not found');
  });
});

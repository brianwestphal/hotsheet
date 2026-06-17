// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetCommandRunTimesForTesting,
  getCommandLastRun,
  recordCommandRun,
} from './commandRunTimes.js';

describe('commandRunTimes (HS-8398)', () => {
  afterEach(() => {
    _resetCommandRunTimesForTesting();
  });

  it('returns null for a command that has never run', () => {
    expect(getCommandLastRun('secret-a::shell::Build::npm run build')).toBeNull();
  });

  it('records and reads back a run timestamp for a composite key', () => {
    const key = 'secret-a::shell::Build::npm run build';
    recordCommandRun(key, '2026-06-17T10:00:00.000Z');
    expect(getCommandLastRun(key)).toBe('2026-06-17T10:00:00.000Z');
  });

  it('a later run overwrites the earlier timestamp', () => {
    const key = 'secret-a::shell::Test::npm test';
    recordCommandRun(key, '2026-06-17T10:00:00.000Z');
    recordCommandRun(key, '2026-06-17T11:30:00.000Z');
    expect(getCommandLastRun(key)).toBe('2026-06-17T11:30:00.000Z');
  });

  it('keeps run times isolated per composite key (per project + command)', () => {
    recordCommandRun('secret-a::claude::Plan::plan it', '2026-06-17T09:00:00.000Z');
    recordCommandRun('secret-b::claude::Plan::plan it', '2026-06-17T09:30:00.000Z');
    expect(getCommandLastRun('secret-a::claude::Plan::plan it')).toBe('2026-06-17T09:00:00.000Z');
    expect(getCommandLastRun('secret-b::claude::Plan::plan it')).toBe('2026-06-17T09:30:00.000Z');
  });

  it('defaults the timestamp to now (ISO) when not provided', () => {
    const key = 'secret-a::shell::Now::echo now';
    recordCommandRun(key);
    const got = getCommandLastRun(key);
    expect(got).not.toBeNull();
    // Round-trips through Date without throwing → a valid ISO timestamp.
    expect(Number.isNaN(new Date(got as string).getTime())).toBe(false);
  });

  it('ignores an empty composite key (no-op)', () => {
    recordCommandRun('', '2026-06-17T10:00:00.000Z');
    expect(getCommandLastRun('')).toBeNull();
  });

  it('survives corrupt localStorage by treating it as empty', () => {
    window.localStorage.setItem('hotsheet:command-last-run', '{not valid json');
    expect(getCommandLastRun('secret-a::shell::X::x')).toBeNull();
    // And a subsequent record still works (overwrites the corrupt blob).
    recordCommandRun('secret-a::shell::X::x', '2026-06-17T12:00:00.000Z');
    expect(getCommandLastRun('secret-a::shell::X::x')).toBe('2026-06-17T12:00:00.000Z');
  });
});

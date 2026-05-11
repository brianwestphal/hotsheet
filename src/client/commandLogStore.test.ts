// @vitest-environment happy-dom
/**
 * §61 Phase 3b / HS-8318 — unit tests for `commandLogStore`. The store
 * lifts the bespoke `currentEntries` LogEntry array + `activeFilterTypes`
 * `Set\<string\>` + `currentSearch` string + `latestPartialOutputs`
 * `Map\<number, string\>` from `commandLog.tsx` and `commandLogFilter.tsx`
 * into a kerf `defineStore` with keyed-merge entries + per-entry
 * partial-output signals. These tests pin the store action contract +
 * keyed-merge semantics + per-entry signal stability in isolation;
 * integration with the `bindList` view-layer is covered by
 * `commandLog.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _clearPerEntrySignalsForTesting,
  _commandLogStoreForTesting,
  ALL_FILTER_TYPE_VALUES,
  type CommandLogEntry,
  commandLogStore,
  filteredEntriesSignal,
  getEntrySignals,
  orderedEntriesSignal,
} from './commandLogStore.js';
import { effect } from './reactive.js';

beforeEach(() => {
  _commandLogStoreForTesting.reset();
  _clearPerEntrySignalsForTesting();
});

afterEach(() => {
  _commandLogStoreForTesting.reset();
  _clearPerEntrySignalsForTesting();
});

function entry(id: number, overrides: Partial<CommandLogEntry> = {}): CommandLogEntry {
  return {
    id,
    event_type: 'trigger',
    direction: 'outgoing',
    summary: `entry ${id}`,
    detail: '',
    created_at: '2026-05-11T00:00:00Z',
    ...overrides,
  };
}

describe('commandLogStore — initial state', () => {
  it('starts with empty entryIds and all filter types selected', () => {
    expect(commandLogStore.state.value.entryIds).toEqual([]);
    expect(commandLogStore.state.value.filter.types.size).toBe(ALL_FILTER_TYPE_VALUES.length);
    expect(commandLogStore.state.value.filter.search).toBe('');
  });

  it('reset() returns to initial after mutations', () => {
    commandLogStore.actions.setEntries([entry(1), entry(2)], []);
    commandLogStore.actions.setFilterSearch('hello');
    _commandLogStoreForTesting.reset();
    _clearPerEntrySignalsForTesting();
    expect(commandLogStore.state.value.entryIds).toEqual([]);
    expect(commandLogStore.state.value.filter.search).toBe('');
  });
});

describe('commandLogStore — setEntries keyed-merge', () => {
  it('appends new ids to the entryIds ordering', () => {
    commandLogStore.actions.setEntries([entry(1), entry(2)], []);
    expect(commandLogStore.state.value.entryIds).toEqual([1, 2]);
    commandLogStore.actions.setEntries([entry(1), entry(2), entry(3)], []);
    expect(commandLogStore.state.value.entryIds).toEqual([1, 2, 3]);
  });

  it('per-entry signal reference SURVIVES across polls when the entry id survives', () => {
    commandLogStore.actions.setEntries([entry(1)], []);
    const ref1 = getEntrySignals(1);
    expect(ref1).toBeDefined();
    commandLogStore.actions.setEntries([entry(1), entry(2)], []);
    const ref2 = getEntrySignals(1);
    expect(ref2).toBe(ref1);
  });

  it('drops per-entry signals for ids that age off the server response', () => {
    commandLogStore.actions.setEntries([entry(1), entry(2)], []);
    expect(getEntrySignals(1)).toBeDefined();
    commandLogStore.actions.setEntries([entry(2), entry(3)], []);
    expect(getEntrySignals(1)).toBeUndefined();
    expect(getEntrySignals(2)).toBeDefined();
    expect(getEntrySignals(3)).toBeDefined();
  });

  it('does NOT fire the per-entry signal on a no-op poll (structural equality)', () => {
    commandLogStore.actions.setEntries([entry(1, { detail: 'foo' })], []);
    let fires = 0;
    const stop = effect(() => {
      void getEntrySignals(1)?.entry.value;
      fires++;
    });
    fires = 0; // reset post-register

    // Same content, fresh object reference (simulates a poll re-fetch).
    commandLogStore.actions.setEntries([entry(1, { detail: 'foo' })], []);
    expect(fires).toBe(0);
    stop();
  });

  it('fires the per-entry signal when detail changes (running → done)', () => {
    commandLogStore.actions.setEntries([entry(1, { event_type: 'shell_command', detail: '' })], [1]);
    let fires = 0;
    const stop = effect(() => {
      void getEntrySignals(1)?.entry.value;
      fires++;
    });
    fires = 0;

    // Same id, new detail (the running → done transition).
    commandLogStore.actions.setEntries(
      [entry(1, { event_type: 'shell_command', detail: 'ls\n---SHELL_OUTPUT---\noutput' })],
      [], // no longer running
    );
    expect(fires).toBe(1);
    stop();
  });

  it('annotates isRunningShell based on event_type + runningIds membership', () => {
    commandLogStore.actions.setEntries(
      [
        entry(1, { event_type: 'shell_command' }),
        entry(2, { event_type: 'shell_command' }),
        entry(3, { event_type: 'trigger' }),
      ],
      [1, 3], // 3 isn't a shell_command, so it should NOT be marked running
    );
    expect(getEntrySignals(1)!.entry.value.isRunningShell).toBe(true);
    expect(getEntrySignals(2)!.entry.value.isRunningShell).toBe(false);
    expect(getEntrySignals(3)!.entry.value.isRunningShell).toBe(false);
  });

  it('updates isRunningShell when the entry transitions out of runningIds', () => {
    commandLogStore.actions.setEntries(
      [entry(1, { event_type: 'shell_command' })],
      [1],
    );
    expect(getEntrySignals(1)!.entry.value.isRunningShell).toBe(true);
    commandLogStore.actions.setEntries(
      [entry(1, { event_type: 'shell_command', detail: 'done' })],
      [],
    );
    expect(getEntrySignals(1)!.entry.value.isRunningShell).toBe(false);
  });

  it('does NOT churn entryIds when the ordering is identical', () => {
    commandLogStore.actions.setEntries([entry(1), entry(2)], []);
    const ref1 = commandLogStore.state.value.entryIds;
    commandLogStore.actions.setEntries([entry(1), entry(2)], []);
    expect(commandLogStore.state.value.entryIds).toBe(ref1);
  });

  it('churns entryIds when the ordering changes', () => {
    commandLogStore.actions.setEntries([entry(1), entry(2)], []);
    commandLogStore.actions.setEntries([entry(2), entry(1)], []);
    expect(commandLogStore.state.value.entryIds).toEqual([2, 1]);
  });
});

describe('commandLogStore — setRunningOutput', () => {
  it('writes to the per-entry partial signal', () => {
    commandLogStore.actions.setEntries([entry(1, { event_type: 'shell_command' })], [1]);
    commandLogStore.actions.setRunningOutput(1, 'hello world');
    expect(getEntrySignals(1)!.partial.value).toBe('hello world');
  });

  it('lazy-creates a placeholder per-entry signal when the id is not tracked yet (race-safety)', () => {
    expect(() => commandLogStore.actions.setRunningOutput(99, 'early-chunk')).not.toThrow();
    const sigs = getEntrySignals(99);
    expect(sigs).toBeDefined();
    expect(sigs!.partial.value).toBe('early-chunk');
    expect(sigs!.entry.value.isRunningShell).toBe(true);
  });

  it('a subsequent setEntries replaces the lazy placeholder with the real entry', () => {
    commandLogStore.actions.setRunningOutput(99, 'early');
    const before = getEntrySignals(99)!;
    commandLogStore.actions.setEntries(
      [entry(99, { event_type: 'shell_command', summary: 'real entry' })],
      [99],
    );
    const after = getEntrySignals(99)!;
    expect(after).toBe(before); // signal references survive
    expect(after.entry.value.summary).toBe('real entry');
    // Partial output is preserved across the placeholder → real transition.
    expect(after.partial.value).toBe('early');
  });

  it('lazy placeholder GCs on the next setEntries when the id is not in the server response', () => {
    commandLogStore.actions.setRunningOutput(99, 'orphan');
    expect(getEntrySignals(99)).toBeDefined();
    commandLogStore.actions.setEntries([entry(1)], []);
    expect(getEntrySignals(99)).toBeUndefined();
  });

  it('does NOT fire other entries\' partial signals (per-row isolation)', () => {
    commandLogStore.actions.setEntries(
      [entry(1, { event_type: 'shell_command' }), entry(2, { event_type: 'shell_command' })],
      [1, 2],
    );
    let fires2 = 0;
    const stop = effect(() => {
      void getEntrySignals(2)?.partial.value;
      fires2++;
    });
    fires2 = 0;

    commandLogStore.actions.setRunningOutput(1, 'chunk for #1');
    expect(fires2).toBe(0);
    stop();
  });

  it('does NOT fire on a no-op set (same text)', () => {
    commandLogStore.actions.setEntries([entry(1, { event_type: 'shell_command' })], [1]);
    commandLogStore.actions.setRunningOutput(1, 'x');
    let fires = 0;
    const stop = effect(() => {
      void getEntrySignals(1)?.partial.value;
      fires++;
    });
    fires = 0;
    commandLogStore.actions.setRunningOutput(1, 'x');
    expect(fires).toBe(0);
    stop();
  });
});

describe('commandLogStore — filter actions', () => {
  it('setFilterTypes replaces the type set', () => {
    commandLogStore.actions.setFilterTypes(new Set(['shell_command']));
    expect([...commandLogStore.state.value.filter.types]).toEqual(['shell_command']);
  });

  it('setFilterSearch replaces the search string', () => {
    commandLogStore.actions.setFilterSearch('ls');
    expect(commandLogStore.state.value.filter.search).toBe('ls');
  });

  it('setFilterSearch is a no-op when the value is identical', () => {
    commandLogStore.actions.setFilterSearch('x');
    const ref1 = commandLogStore.state.value;
    commandLogStore.actions.setFilterSearch('x');
    expect(commandLogStore.state.value).toBe(ref1);
  });
});

describe('orderedEntriesSignal — derived', () => {
  it('returns entries in entryIds order', () => {
    commandLogStore.actions.setEntries([entry(3), entry(1), entry(2)], []);
    expect(orderedEntriesSignal.value.map(e => e.id)).toEqual([3, 1, 2]);
  });

  it('reflects per-entry signal updates (running → done)', () => {
    commandLogStore.actions.setEntries([entry(1, { event_type: 'shell_command', detail: '' })], [1]);
    expect(orderedEntriesSignal.value[0].detail).toBe('');
    commandLogStore.actions.setEntries(
      [entry(1, { event_type: 'shell_command', detail: 'output here' })],
      [],
    );
    expect(orderedEntriesSignal.value[0].detail).toBe('output here');
    expect(orderedEntriesSignal.value[0].isRunningShell).toBe(false);
  });
});

describe('filteredEntriesSignal — derived', () => {
  it('returns the full list when every type is selected', () => {
    commandLogStore.actions.setEntries(
      [entry(1, { event_type: 'trigger' }), entry(2, { event_type: 'shell_command' })],
      [],
    );
    expect(filteredEntriesSignal.value).toHaveLength(2);
  });

  it('narrows the list to the selected types only', () => {
    commandLogStore.actions.setEntries(
      [
        entry(1, { event_type: 'trigger' }),
        entry(2, { event_type: 'shell_command' }),
        entry(3, { event_type: 'permission_request' }),
      ],
      [],
    );
    commandLogStore.actions.setFilterTypes(new Set(['shell_command']));
    expect(filteredEntriesSignal.value.map(e => e.id)).toEqual([2]);
  });

  it('returns an empty list when no type matches', () => {
    commandLogStore.actions.setEntries([entry(1, { event_type: 'trigger' })], []);
    commandLogStore.actions.setFilterTypes(new Set(['shell_command']));
    expect(filteredEntriesSignal.value).toEqual([]);
  });
});

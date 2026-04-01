import { describe, expect, it, vi } from 'vitest';

import type { UndoEntry } from './types.js';

function makeEntry(overrides: Partial<UndoEntry> = {}): UndoEntry {
  return {
    label: 'test',
    timestamp: Date.now(),
    before: [{ id: 1, title: 'before', details: '', category: 'task', priority: 'default', status: 'not_started', up_next: false }],
    after: [{ id: 1, title: 'after', details: '', category: 'task', priority: 'default', status: 'not_started', up_next: false }],
    ...overrides,
  };
}

async function freshStack() {
  vi.resetModules();
  const mod = await import('./stack.js');
  return mod.undoStack;
}

describe('UndoStack', () => {
  describe('push and canUndo', () => {
    it('starts empty with canUndo false', async () => {
      const stack = await freshStack();
      expect(stack.canUndo()).toBe(false);
      expect(stack.canRedo()).toBe(false);
    });

    it('canUndo is true after push', async () => {
      const stack = await freshStack();
      stack.push(makeEntry());
      expect(stack.canUndo()).toBe(true);
    });

    it('clears redo stack on push', async () => {
      const stack = await freshStack();
      stack.push(makeEntry({ label: 'first' }));
      stack.popUndo(); // moves to redo
      expect(stack.canRedo()).toBe(true);
      stack.push(makeEntry({ label: 'second' }));
      expect(stack.canRedo()).toBe(false);
    });
  });

  describe('popUndo', () => {
    it('returns the most recent entry', async () => {
      const stack = await freshStack();
      const entry = makeEntry({ label: 'my-action' });
      stack.push(entry);
      const popped = stack.popUndo();
      expect(popped).toBe(entry);
      expect(popped!.label).toBe('my-action');
    });

    it('returns undefined when empty', async () => {
      const stack = await freshStack();
      expect(stack.popUndo()).toBeUndefined();
    });

    it('moves entry to redo stack', async () => {
      const stack = await freshStack();
      stack.push(makeEntry());
      stack.popUndo();
      expect(stack.canUndo()).toBe(false);
      expect(stack.canRedo()).toBe(true);
    });
  });

  describe('popRedo', () => {
    it('returns the most recently undone entry', async () => {
      const stack = await freshStack();
      const entry = makeEntry({ label: 'redoable' });
      stack.push(entry);
      stack.popUndo();
      const redone = stack.popRedo();
      expect(redone).toBe(entry);
      expect(redone!.label).toBe('redoable');
    });

    it('returns undefined when redo stack is empty', async () => {
      const stack = await freshStack();
      expect(stack.popRedo()).toBeUndefined();
    });

    it('moves entry back to undo stack', async () => {
      const stack = await freshStack();
      stack.push(makeEntry());
      stack.popUndo();
      stack.popRedo();
      expect(stack.canUndo()).toBe(true);
      expect(stack.canRedo()).toBe(false);
    });
  });

  describe('peekUndo', () => {
    it('returns the top entry without removing it', async () => {
      const stack = await freshStack();
      const entry = makeEntry({ label: 'peek-me' });
      stack.push(entry);
      expect(stack.peekUndo()).toBe(entry);
      expect(stack.canUndo()).toBe(true); // still there
    });

    it('returns undefined when empty', async () => {
      const stack = await freshStack();
      expect(stack.peekUndo()).toBeUndefined();
    });
  });

  describe('undo/redo ordering (LIFO)', () => {
    it('pops entries in reverse push order', async () => {
      const stack = await freshStack();
      stack.push(makeEntry({ label: 'first' }));
      stack.push(makeEntry({ label: 'second' }));
      stack.push(makeEntry({ label: 'third' }));

      expect(stack.popUndo()!.label).toBe('third');
      expect(stack.popUndo()!.label).toBe('second');
      expect(stack.popUndo()!.label).toBe('first');
      expect(stack.canUndo()).toBe(false);
    });

    it('redo replays in original order after multiple undos', async () => {
      const stack = await freshStack();
      stack.push(makeEntry({ label: 'a' }));
      stack.push(makeEntry({ label: 'b' }));

      stack.popUndo(); // undo b
      stack.popUndo(); // undo a

      expect(stack.popRedo()!.label).toBe('a');
      expect(stack.popRedo()!.label).toBe('b');
    });
  });

  describe('max stack depth', () => {
    it('drops oldest entry when exceeding 1000 items', async () => {
      const stack = await freshStack();
      for (let i = 0; i < 1001; i++) {
        stack.push(makeEntry({ label: `entry-${i}` }));
      }
      // The first entry (entry-0) should have been shifted off
      // We should have exactly 1000 entries, from entry-1 to entry-1000
      // Popping all should give us entry-1000 first, entry-1 last
      let count = 0;
      let last: UndoEntry | undefined;
      let entry: UndoEntry | undefined;
      while ((entry = stack.popUndo())) {
        last = entry;
        count++;
      }
      expect(count).toBe(1000);
      expect(last!.label).toBe('entry-1');
    });
  });

  describe('coalesce', () => {
    it('returns false when coalescingKey is null or empty', async () => {
      const stack = await freshStack();
      stack.push(makeEntry({ coalescingKey: 'key' }));
      expect(stack.coalesce(makeEntry({ coalescingKey: undefined }))).toBe(false);
      expect(stack.coalesce(makeEntry({ coalescingKey: '' }))).toBe(false);
    });

    it('returns false when undo stack is empty', async () => {
      const stack = await freshStack();
      expect(stack.coalesce(makeEntry({ coalescingKey: 'key' }))).toBe(false);
    });

    it('returns false when keys do not match', async () => {
      const stack = await freshStack();
      stack.push(makeEntry({ coalescingKey: 'key-a' }));
      expect(stack.coalesce(makeEntry({ coalescingKey: 'key-b' }))).toBe(false);
    });

    it('returns false when timestamp exceeds coalesce interval (5s)', async () => {
      const stack = await freshStack();
      const now = Date.now();
      stack.push(makeEntry({ coalescingKey: 'key', timestamp: now }));
      expect(stack.coalesce(makeEntry({ coalescingKey: 'key', timestamp: now + 5000 }))).toBe(false);
    });

    it('coalesces when key matches and within time window', async () => {
      const stack = await freshStack();
      const now = Date.now();
      const afterBefore = [{ id: 1, title: 'v1', details: '', category: 'task', priority: 'default', status: 'not_started', up_next: false }];
      const afterAfter = [{ id: 1, title: 'v2', details: '', category: 'task', priority: 'default', status: 'not_started', up_next: false }];
      const finalAfter = [{ id: 1, title: 'v3', details: '', category: 'task', priority: 'default', status: 'not_started', up_next: false }];

      stack.push(makeEntry({ coalescingKey: 'key', timestamp: now, before: afterBefore, after: afterAfter }));
      const result = stack.coalesce(makeEntry({ coalescingKey: 'key', timestamp: now + 1000, after: finalAfter }));

      expect(result).toBe(true);
      // The top entry's `after` should be updated, but `before` should remain original
      const top = stack.peekUndo()!;
      expect(top.before).toBe(afterBefore);
      expect(top.after).toBe(finalAfter);
    });

    it('coalesces at exactly 4999ms (just under threshold)', async () => {
      const stack = await freshStack();
      const now = Date.now();
      stack.push(makeEntry({ coalescingKey: 'k', timestamp: now }));
      expect(stack.coalesce(makeEntry({ coalescingKey: 'k', timestamp: now + 4999 }))).toBe(true);
    });
  });
});

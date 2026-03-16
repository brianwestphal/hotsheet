import type { UndoEntry } from './types.js';

const MAX_STACK_DEPTH = 1000;
const COALESCE_INTERVAL_MS = 5000;

class UndoStack {
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];

  push(entry: UndoEntry) {
    console.log('[undo] push:', entry.label, 'stack depth:', this.undoStack.length + 1, 'before:', JSON.stringify(entry.before), 'after:', JSON.stringify(entry.after));
    this.undoStack.push(entry);
    if (this.undoStack.length > MAX_STACK_DEPTH) {
      this.undoStack.shift();
    }
    this.redoStack = [];
  }

  /** Try to coalesce with the top entry. Returns true if coalesced, false if a new push is needed. */
  coalesce(entry: UndoEntry): boolean {
    if (entry.coalescingKey == null || entry.coalescingKey === '') return false;
    const top = this.peekUndo();
    if (!top) return false;
    if (top.coalescingKey !== entry.coalescingKey) return false;
    if (entry.timestamp - top.timestamp >= COALESCE_INTERVAL_MS) return false;

    // Update the top entry's after-state with the new value, keep original before
    top.after = entry.after;
    return true;
  }

  popUndo(): UndoEntry | undefined {
    const entry = this.undoStack.pop();
    if (entry) this.redoStack.push(entry);
    return entry;
  }

  popRedo(): UndoEntry | undefined {
    const entry = this.redoStack.pop();
    if (entry) this.undoStack.push(entry);
    return entry;
  }

  peekUndo(): UndoEntry | undefined {
    return this.undoStack[this.undoStack.length - 1];
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }
}

export const undoStack = new UndoStack();

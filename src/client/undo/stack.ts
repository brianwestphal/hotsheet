import type { UndoEntry } from './types.js';

const MAX_STACK_DEPTH = 1000;
const COALESCE_INTERVAL_MS = 5000;

export class UndoStack {
  private undoStack: UndoEntry[] = [];
  private redoStack: UndoEntry[] = [];

  push(entry: UndoEntry) {
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

// HS-9335 — one UndoStack PER PROJECT, keyed by project secret, so undo/redo never
// reaches across project tabs (each tab has its own history). `getUndoStack('')` is the
// fallback stack used when no project is active. `actions.ts` resolves the active
// project's stack on every operation via `getActiveProject()?.secret`.
const stacks = new Map<string, UndoStack>();

export function getUndoStack(key: string): UndoStack {
  let s = stacks.get(key);
  if (s === undefined) {
    s = new UndoStack();
    stacks.set(key, s);
  }
  return s;
}

/** Drop a project's undo history (e.g. when its tab is closed / project removed). */
export function clearUndoStack(key: string): void {
  stacks.delete(key);
}

/** Back-compat default stack (key `''`). Kept for direct importers; new code goes
 *  through `getUndoStack(projectKey)`. */
export const undoStack = getUndoStack('');

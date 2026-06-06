/**
 * §78 Announcer (HS-8747) — playback state machine for the transcript PIP.
 *
 * Drives sequential narration of a list of `Announcement` entries through an
 * injectable `SpeechEngine` (`tts.ts`). Kept free of DOM so it's unit-testable
 * with a fake engine; the PIP (`announcerPip.tsx`) renders from its callbacks.
 *
 * **Stale-resolution guard.** `engine.speak()` is async and resolves on the
 * utterance's natural end — but the user can interrupt at any time (pause,
 * prev/next, skip, close). Every utterance captures a monotonically increasing
 * `utteranceToken`; an interrupting action bumps the token and cancels the
 * engine, so the old utterance's late resolution is recognized as stale and
 * ignored. Only the active utterance's `'ended'` triggers auto-advance.
 */
import type { Announcement } from '../api/announcer.js';
import type { SpeechEngine } from './tts.js';

export type PlayerState = 'idle' | 'playing' | 'paused' | 'done';

export interface PlayerCallbacks<T extends Announcement = Announcement> {
  /** Fired whenever the active entry changes (or is first shown). */
  onEntryChange?(index: number, entry: T, total: number): void;
  /** Fired on every play/pause/done transition. */
  onStateChange?(state: PlayerState): void;
  /** Fired once when the reel finishes playing through naturally. */
  onComplete?(): void;
  /** Fired when an entry is removed via `removeCurrent()` (skip / dismiss) so
   *  the host can persist the dismissal. */
  onRemove?(entry: T): void;
  /** Maps an entry to the text actually spoken — distinct from the displayed
   *  `script` so the host can prepend context the listener can't see, e.g. the
   *  owning project name in "All Projects" mode (HS-8782). Defaults to
   *  `entry.script` when omitted. */
  speechTextFor?(entry: T): string;
}

/** `T` carries any per-entry metadata the host needs back in callbacks — e.g.
 *  the owning project (HS-8762 "All Projects" reel) so the chip + the dismiss
 *  target the right project. Defaults to a plain `Announcement`. */
export class AnnouncerPlayer<T extends Announcement = Announcement> {
  private readonly engine: SpeechEngine;
  private readonly cbs: PlayerCallbacks<T>;
  private entries: T[];
  private index = 0;
  private state: PlayerState = 'idle';
  private utteranceToken = 0;
  /** Playback speed multiplier (1 = normal; HS-8754). */
  private rate = 1;
  /** HS-8781 — tasks to run at the next segment boundary (between the current
   *  utterance ending naturally and the next one starting), so a higher-priority
   *  announcement (e.g. a permission check) can pre-empt UPCOMING segments
   *  without interrupting the one in flight. */
  private pendingBoundaryTasks: (() => void | Promise<void>)[] = [];

  constructor(entries: T[], engine: SpeechEngine, callbacks: PlayerCallbacks<T> = {}) {
    this.entries = [...entries];
    this.engine = engine;
    this.cbs = callbacks;
  }

  // --- Queries ---
  getState(): PlayerState { return this.state; }
  getIndex(): number { return this.index; }
  getCount(): number { return this.entries.length; }
  getCurrentEntry(): T | null { return this.entries.at(this.index) ?? null; }

  /** Replace the reel (HS-8762 context switch) and restart from the top. */
  setEntries(entries: T[]): void {
    this.interrupt();
    this.entries = [...entries];
    this.index = 0;
    if (this.entries.length === 0) { this.finish(); return; }
    if (this.engine.backend === 'none') {
      this.setState('paused');
      this.emitEntryChange();
    } else {
      this.speakCurrent();
    }
  }

  /** Append new entries to the END of the reel (HS-8767 live tailing) without
   *  disturbing the current position. If the reel had already finished ('done'),
   *  resume into the first newly-appended entry; otherwise the player reaches
   *  them naturally as it advances. */
  appendEntries(entries: T[]): void {
    if (entries.length === 0) return;
    const wasDone = this.state === 'done' || (this.state === 'idle' && this.entries.length === 0);
    const resumeIndex = this.entries.length;
    this.entries.push(...entries);
    if (!wasDone) {
      // Still playing/paused — just refresh the position label (N / M grew).
      this.emitEntryChange();
      return;
    }
    this.index = resumeIndex;
    if (this.engine.backend === 'none') {
      this.setState('paused');
      this.emitEntryChange();
    } else {
      this.speakCurrent();
    }
  }

  /** Skip the backlog and jump to the newest entry (HS-8767 skip-catch-up). */
  jumpToLast(): void {
    if (this.entries.length === 0) return;
    this.interrupt();
    this.index = this.entries.length - 1;
    if (this.engine.backend === 'none') {
      this.setState('paused');
      this.emitEntryChange();
    } else {
      this.speakCurrent();
    }
  }
  getBackend(): SpeechEngine['backend'] { return this.engine.backend; }
  /** True when the active backend can pause/resume mid-utterance (browser). */
  canPauseResume(): boolean { return this.engine.supportsPauseResume; }
  getRate(): number { return this.rate; }

  /**
   * HS-8781 — run `task` at the next segment boundary so a time-sensitive
   * announcement can speak between segments. If a segment is currently in
   * flight, the task is deferred until it ends naturally (the current segment is
   * never interrupted) and runs BEFORE the next segment starts. If nothing is
   * speaking, the task runs immediately. The caller awaits nothing; the player
   * resumes the reel after the task(s) settle.
   */
  runAtNextBoundary(task: () => void | Promise<void>): void {
    if (this.state === 'playing') {
      this.pendingBoundaryTasks.push(task);
    } else {
      void task();
    }
  }

  /** Set the playback speed (HS-8754). Takes effect on the next utterance; if a
   *  voice is currently speaking, re-speaks the current entry at the new rate so
   *  the change is immediately audible. */
  setRate(rate: number): void {
    if (rate === this.rate) return;
    this.rate = rate;
    if (this.state === 'playing' && this.engine.backend !== 'none') {
      // Cancel the in-flight utterance first (so the browser doesn't queue a
      // second voice on top), then re-speak the current entry at the new rate.
      this.interrupt();
      this.speakCurrent();
    }
  }

  // --- Commands ---

  /** Start (from idle), resume (from paused), or no-op (already playing /
   *  done / empty). On a non-resumable backend, resuming re-speaks the current
   *  entry from the start (the OS voice has no mid-utterance resume). */
  play(): void {
    if (this.entries.length === 0) return;
    if (this.state === 'playing' || this.state === 'done') return;
    if (this.state === 'paused' && this.engine.supportsPauseResume) {
      this.engine.resume();
      this.setState('playing');
      return;
    }
    this.speakCurrent();
  }

  /** Pause the current utterance. Browser pauses mid-sentence; other backends
   *  stop and re-speak on the next `play()`. */
  pause(): void {
    if (this.state !== 'playing') return;
    if (this.engine.supportsPauseResume) {
      this.engine.pause();
    } else {
      // Invalidate the in-flight utterance so its eventual resolution is
      // ignored, then stop the OS voice.
      this.utteranceToken++;
      this.engine.cancel();
    }
    this.setState('paused');
  }

  togglePlayPause(): void {
    if (this.state === 'playing') this.pause();
    else this.play();
  }

  /** Advance to the next entry and play it. At the last entry, finishes. */
  next(): void {
    if (this.index >= this.entries.length - 1) {
      this.interrupt();
      this.finish();
      return;
    }
    this.goTo(this.index + 1);
  }

  /** Go to the previous entry and play it. At the first entry, restarts it. */
  prev(): void {
    this.goTo(Math.max(0, this.index - 1));
  }

  /** Remove the current entry (skip / mark uninteresting) and advance. Fires
   *  `onRemove` so the host can persist the dismissal. Finishes when the reel
   *  empties. */
  removeCurrent(): void {
    const entry = this.entries.at(this.index);
    if (entry === undefined) return;
    this.interrupt();
    this.entries.splice(this.index, 1);
    this.cbs.onRemove?.(entry);
    if (this.entries.length === 0) {
      this.finish();
      return;
    }
    // Stay at the same index (now the following entry) — clamp to the new end.
    this.index = Math.min(this.index, this.entries.length - 1);
    if (this.engine.backend === 'none') {
      this.setState('paused');
      this.emitEntryChange();
    } else {
      this.speakCurrent();
    }
  }

  /** Stop playback and tear down (PIP closed). No further callbacks fire. */
  dispose(): void {
    this.interrupt();
    this.state = 'idle';
  }

  // --- Internals ---

  private goTo(index: number): void {
    this.interrupt();
    this.index = Math.max(0, Math.min(this.entries.length - 1, index));
    if (this.engine.backend === 'none') {
      this.setState('paused');
      this.emitEntryChange();
    } else {
      this.speakCurrent();
    }
  }

  /** Invalidate any in-flight utterance and silence the engine. */
  private interrupt(): void {
    this.utteranceToken++;
    this.engine.cancel();
  }

  private speakCurrent(): void {
    const entry = this.entries.at(this.index);
    if (entry === undefined) { this.finish(); return; }
    this.emitEntryChange();
    if (this.engine.backend === 'none') {
      // No voice — show the transcript, require manual navigation.
      this.setState('paused');
      return;
    }
    const token = ++this.utteranceToken;
    this.setState('playing');
    const text = this.cbs.speechTextFor?.(entry) ?? entry.script;
    void this.engine.speak(text, this.rate).then((result) => {
      if (token !== this.utteranceToken) return; // a newer action superseded us
      if (result === 'ended' || result === 'error') {
        // On natural end OR a TTS error, keep the reel moving rather than
        // stalling on one bad utterance.
        this.advanceAfterEnd();
      }
      // 'cancelled' → an explicit command already drove the next state.
    });
  }

  private advanceAfterEnd(): void {
    // HS-8781 — if a boundary task is queued (e.g. a permission announcement),
    // run it in the gap before the next segment. The current segment has already
    // ended naturally here, so nothing is interrupted.
    if (this.pendingBoundaryTasks.length > 0) {
      void this.drainBoundaryThenAdvance();
      return;
    }
    this.advanceNow();
  }

  private advanceNow(): void {
    if (this.index >= this.entries.length - 1) { this.finish(); return; }
    this.index++;
    this.speakCurrent();
  }

  /** Run all queued boundary tasks, then resume the reel — unless the user drove
   *  a different action during the gap (token bumped), in which case that action
   *  already owns the next state and we bow out. */
  private async drainBoundaryThenAdvance(): Promise<void> {
    const token = this.utteranceToken;
    const tasks = this.pendingBoundaryTasks;
    this.pendingBoundaryTasks = [];
    for (const t of tasks) {
      try { await t(); } catch { /* a bad task must not stall the reel */ }
    }
    if (token !== this.utteranceToken) return; // superseded by a user action
    this.advanceNow();
  }

  private finish(): void {
    this.setState('done');
    this.cbs.onComplete?.();
  }

  private emitEntryChange(): void {
    const entry = this.entries.at(this.index);
    if (entry !== undefined) this.cbs.onEntryChange?.(this.index, entry, this.entries.length);
  }

  private setState(state: PlayerState): void {
    if (this.state === state) return;
    this.state = state;
    this.cbs.onStateChange?.(state);
  }
}

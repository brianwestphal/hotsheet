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

export interface PlayerCallbacks {
  /** Fired whenever the active entry changes (or is first shown). */
  onEntryChange?(index: number, entry: Announcement, total: number): void;
  /** Fired on every play/pause/done transition. */
  onStateChange?(state: PlayerState): void;
  /** Fired once when the reel finishes playing through naturally. */
  onComplete?(): void;
  /** Fired when an entry is removed via `removeCurrent()` (skip / dismiss) so
   *  the host can persist the dismissal. */
  onRemove?(entry: Announcement): void;
}

export class AnnouncerPlayer {
  private readonly engine: SpeechEngine;
  private readonly cbs: PlayerCallbacks;
  private entries: Announcement[];
  private index = 0;
  private state: PlayerState = 'idle';
  private utteranceToken = 0;

  constructor(entries: Announcement[], engine: SpeechEngine, callbacks: PlayerCallbacks = {}) {
    this.entries = [...entries];
    this.engine = engine;
    this.cbs = callbacks;
  }

  // --- Queries ---
  getState(): PlayerState { return this.state; }
  getIndex(): number { return this.index; }
  getCount(): number { return this.entries.length; }
  getCurrentEntry(): Announcement | null { return this.entries.at(this.index) ?? null; }
  getBackend(): SpeechEngine['backend'] { return this.engine.backend; }
  /** True when the active backend can pause/resume mid-utterance (browser). */
  canPauseResume(): boolean { return this.engine.supportsPauseResume; }

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
    void this.engine.speak(entry.script).then((result) => {
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
    if (this.index >= this.entries.length - 1) { this.finish(); return; }
    this.index++;
    this.speakCurrent();
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

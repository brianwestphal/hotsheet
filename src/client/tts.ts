/**
 * §78 Announcer (HS-8747) — text-to-speech abstraction for the after-the-fact
 * audio MVP. Two backends behind one interface, chosen at runtime per the
 * HS-8744 spike:
 *
 * - **Tauri desktop primary** — the `tts_speak` / `tts_stop` Rust commands
 *   (`src-tauri/src/lib.rs`) drive the OS voice (`say` on macOS). This
 *   sidesteps the unverified WKWebView `speechSynthesis` reliability question.
 * - **Browser** — the Web Speech API (`speechSynthesis`), zero config/cost.
 *
 * The player (`announcerPlayer.ts`) consumes a `SpeechEngine`; the concrete
 * engine is injectable so the playback state machine is unit-testable with a
 * fake. `speak()` resolves with a discriminated result so the player can tell
 * a natural finish (`'ended'` → auto-advance) from an interruption
 * (`'cancelled'` → an explicit pause/skip/nav drove the next state) — see
 * `announcerPlayer.ts`.
 */
import { getTauriInvoke } from './tauriIntegration.js';

export type SpeakResult = 'ended' | 'cancelled' | 'error';

export interface SpeechEngine {
  /** Which concrete backend is in use. `'none'` means no speech is available
   *  (old browser); the player falls back to transcript-only (no auto-advance). */
  readonly backend: 'tauri' | 'browser' | 'none';
  /** True only for backends that can pause/resume mid-utterance (browser).
   *  For the rest, the player models pause as stop + re-speak-from-start. */
  readonly supportsPauseResume: boolean;
  /** Speak `text`, resolving when the utterance finishes or is cancelled. */
  speak(text: string): Promise<SpeakResult>;
  /** Interrupt the current utterance. The in-flight `speak()` resolves
   *  `'cancelled'`. */
  cancel(): void;
  /** Pause the current utterance (browser only — no-op elsewhere). */
  pause(): void;
  /** Resume a paused utterance (browser only — no-op elsewhere). */
  resume(): void;
}

/** Pure backend selection — exported for unit testing. */
export function pickBackend(env: { hasInvoke: boolean; hasSpeechSynthesis: boolean }): SpeechEngine['backend'] {
  if (env.hasInvoke) return 'tauri';
  if (env.hasSpeechSynthesis) return 'browser';
  return 'none';
}

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

/** Tauri engine — drives the OS voice via the `tts_speak` / `tts_stop`
 *  commands. `say` (and the Linux/Windows equivalents) has no pause, so the
 *  player handles pause via stop + re-speak (`supportsPauseResume: false`). */
export function createTauriEngine(invoke: Invoke): SpeechEngine {
  // Hold the flag on an object + read it through a getter so the `cancel()`
  // closure's mutation isn't hidden from the post-`await` read by TS's
  // control-flow analysis (a bare `let` narrows to `false` at the return,
  // tripping `no-unnecessary-condition` — HS-8747).
  const flag = { cancelled: false };
  const wasCancelled = (): boolean => flag.cancelled;
  return {
    backend: 'tauri',
    supportsPauseResume: false,
    async speak(text: string): Promise<SpeakResult> {
      flag.cancelled = false;
      try {
        // Resolves when the OS voice finishes — or early when `tts_stop`
        // kills the child (the Rust command still resolves Ok in that case,
        // so the `cancelled` flag is what distinguishes the two).
        await invoke('tts_speak', { text });
      } catch {
        return 'error';
      }
      return wasCancelled() ? 'cancelled' : 'ended';
    },
    cancel(): void {
      flag.cancelled = true;
      invoke('tts_stop').catch(() => { /* best-effort interrupt */ });
    },
    pause(): void { this.cancel(); },
    resume(): void { /* no native resume — the player re-speaks the entry */ },
  };
}

/** Browser engine — the Web Speech API. Supports true mid-utterance
 *  pause/resume. */
export function createBrowserEngine(synth: SpeechSynthesis): SpeechEngine {
  let cancelled = false;
  return {
    backend: 'browser',
    supportsPauseResume: true,
    speak(text: string): Promise<SpeakResult> {
      cancelled = false;
      return new Promise<SpeakResult>((resolve) => {
        const utterance = new SpeechSynthesisUtterance(text);
        const finish = (natural: SpeakResult): void => resolve(cancelled ? 'cancelled' : natural);
        // Some engines fire `onend` on cancel, others `onerror('canceled')`;
        // the `cancelled` flag makes either path report `'cancelled'`.
        utterance.onend = () => finish('ended');
        utterance.onerror = () => finish('error');
        synth.speak(utterance);
      });
    },
    cancel(): void {
      cancelled = true;
      synth.cancel();
    },
    pause(): void { synth.pause(); },
    resume(): void { synth.resume(); },
  };
}

/** No-op engine — no speech available. The player shows the transcript and
 *  requires manual navigation (no auto-advance) so it doesn't blow through
 *  every entry instantly. */
export function createNoneEngine(): SpeechEngine {
  return {
    backend: 'none',
    supportsPauseResume: false,
    speak(): Promise<SpeakResult> { return Promise.resolve('ended'); },
    cancel(): void { /* nothing to cancel */ },
    pause(): void { /* no-op */ },
    resume(): void { /* no-op */ },
  };
}

/** Build the right `SpeechEngine` for the current runtime. */
export function createSpeechEngine(): SpeechEngine {
  const invoke = getTauriInvoke();
  const hasSpeechSynthesis = typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && typeof SpeechSynthesisUtterance !== 'undefined';
  const backend = pickBackend({ hasInvoke: invoke !== null, hasSpeechSynthesis });
  if (backend === 'tauri' && invoke !== null) return createTauriEngine(invoke);
  if (backend === 'browser') return createBrowserEngine(window.speechSynthesis);
  return createNoneEngine();
}

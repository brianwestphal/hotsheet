/**
 * §78 Announcer (HS-8747) — TTS abstraction tests. Covers the pure backend
 * selection and each concrete engine's speak/cancel result contract (the
 * player relies on `'ended'` vs `'cancelled'` to decide auto-advance).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBrowserEngine, createNoneEngine, createTauriEngine, pickBackend, rateToMacWpm } from './tts.js';

describe('rateToMacWpm (HS-8754)', () => {
  it('scales the macOS base WPM by the multiplier', () => {
    expect(rateToMacWpm(1)).toBe(175);
    expect(rateToMacWpm(2)).toBe(350);
    expect(rateToMacWpm(0.5)).toBe(88); // round(87.5)
  });
});

describe('pickBackend', () => {
  it('prefers Tauri when invoke is available', () => {
    expect(pickBackend({ hasInvoke: true, hasSpeechSynthesis: true })).toBe('tauri');
    expect(pickBackend({ hasInvoke: true, hasSpeechSynthesis: false })).toBe('tauri');
  });
  it('falls back to the browser Web Speech API', () => {
    expect(pickBackend({ hasInvoke: false, hasSpeechSynthesis: true })).toBe('browser');
  });
  it('reports none when neither is available', () => {
    expect(pickBackend({ hasInvoke: false, hasSpeechSynthesis: false })).toBe('none');
  });
});

describe('createTauriEngine', () => {
  it('resolves "ended" on a clean utterance and invokes tts_speak', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => {
      calls.push([cmd, args]);
      return Promise.resolve(undefined);
    });
    const engine = createTauriEngine(invoke);
    await expect(engine.speak('hello')).resolves.toBe('ended');
    expect(calls[0]).toEqual(['tts_speak', { text: 'hello' }]);
    expect(engine.supportsPauseResume).toBe(false);
    expect(engine.backend).toBe('tauri');
  });

  it('forwards a rate multiplier as macOS words-per-minute (HS-8754)', async () => {
    const calls: [string, Record<string, unknown> | undefined][] = [];
    const invoke = vi.fn((cmd: string, args?: Record<string, unknown>) => { calls.push([cmd, args]); return Promise.resolve(undefined); });
    await createTauriEngine(invoke).speak('hi', 1.5);
    expect(calls[0]).toEqual(['tts_speak', { text: 'hi', rate: rateToMacWpm(1.5) }]);
  });

  it('resolves "cancelled" when cancel() interrupts a speaking child', async () => {
    let resolveSpeak: () => void = () => { /* set below */ };
    const invoke = vi.fn((cmd: string) => {
      if (cmd === 'tts_speak') return new Promise<unknown>((r) => { resolveSpeak = () => r(undefined); });
      return Promise.resolve(undefined);
    });
    const engine = createTauriEngine(invoke);
    const p = engine.speak('hi');
    engine.cancel();              // sets cancelled + fires tts_stop
    resolveSpeak();              // the killed `say` child makes tts_speak resolve Ok
    await expect(p).resolves.toBe('cancelled');
    expect(invoke).toHaveBeenCalledWith('tts_stop');
  });

  it('resolves "error" when the command throws', async () => {
    const invoke = vi.fn(() => Promise.reject(new Error('boom')));
    const engine = createTauriEngine(invoke);
    await expect(engine.speak('hi')).resolves.toBe('error');
  });
});

describe('createBrowserEngine', () => {
  class FakeUtterance {
    text: string;
    rate = 1;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) { this.text = text; }
  }

  afterEach(() => {
    // @ts-expect-error — clean up the stubbed global between cases.
    delete globalThis.SpeechSynthesisUtterance;
  });

  function fakeSynth() {
    const queue: FakeUtterance[] = [];
    return {
      queue,
      speak: (u: FakeUtterance) => { queue.push(u); },
      cancel: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
    };
  }

  it('resolves "ended" when the utterance ends naturally', async () => {
    // @ts-expect-error — stub the global constructor the engine instantiates.
    globalThis.SpeechSynthesisUtterance = FakeUtterance;
    const synth = fakeSynth();
    const engine = createBrowserEngine(synth as unknown as SpeechSynthesis);
    const p = engine.speak('spoken');
    expect(synth.queue[0].text).toBe('spoken');
    synth.queue[0].onend?.();
    await expect(p).resolves.toBe('ended');
    expect(engine.supportsPauseResume).toBe(true);
  });

  it('resolves "cancelled" when cancel() is called before the end fires', async () => {
    // @ts-expect-error — stub the global constructor.
    globalThis.SpeechSynthesisUtterance = FakeUtterance;
    const synth = fakeSynth();
    const engine = createBrowserEngine(synth as unknown as SpeechSynthesis);
    const p = engine.speak('x');
    engine.cancel();
    expect(synth.cancel).toHaveBeenCalled();
    // Even if the engine then fires onend, the cancelled flag wins.
    synth.queue[0].onend?.();
    await expect(p).resolves.toBe('cancelled');
  });

  it('sets the utterance rate from the multiplier (HS-8754)', () => {
    // @ts-expect-error — stub the global constructor.
    globalThis.SpeechSynthesisUtterance = FakeUtterance;
    const synth = fakeSynth();
    void createBrowserEngine(synth as unknown as SpeechSynthesis).speak('spoken', 1.5);
    expect(synth.queue[0].rate).toBe(1.5);
  });

  it('routes pause/resume to the synthesizer', () => {
    // @ts-expect-error — stub the global constructor.
    globalThis.SpeechSynthesisUtterance = FakeUtterance;
    const synth = fakeSynth();
    const engine = createBrowserEngine(synth as unknown as SpeechSynthesis);
    engine.pause();
    engine.resume();
    expect(synth.pause).toHaveBeenCalled();
    expect(synth.resume).toHaveBeenCalled();
  });
});

describe('createNoneEngine', () => {
  it('reports backend "none" and resolves ended immediately', async () => {
    const engine = createNoneEngine();
    expect(engine.backend).toBe('none');
    await expect(engine.speak('whatever')).resolves.toBe('ended');
  });
});

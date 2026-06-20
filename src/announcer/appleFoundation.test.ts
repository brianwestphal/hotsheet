/**
 * HS-8790 / HS-8907 — the Apple Foundation Models provider, now backed by the
 * `apple-fm` package. Availability comes from `apple-fm`'s `probe()`; the
 * summarize call goes through `apple-fm`'s guided-generation `generate()`. The
 * real on-device helper is verified on a desktop; here `probe`/`generate` are
 * injected so nothing spawns and the matrix runs on Linux CI.
 */
import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetAppleFoundationForTesting, _setAppleFoundationForTesting,
  isAppleFoundationAvailable, runAppleFoundationSummarize,
} from './appleFoundation.js';

afterEach(() => {
  _resetAppleFoundationForTesting();
});

describe('isAppleFoundationAvailable', () => {
  it('is true when apple-fm probe reports available', async () => {
    _setAppleFoundationForTesting({ probe: () => Promise.resolve({ available: true }) });
    expect(await isAppleFoundationAvailable()).toBe(true);
  });

  it('is false when probe reports unavailable (with a reason)', async () => {
    _setAppleFoundationForTesting({ probe: () => Promise.resolve({ available: false, reason: 'appleIntelligenceNotEnabled' }) });
    expect(await isAppleFoundationAvailable()).toBe(false);
  });

  it('is false when probe rejects (helper missing / spawn error)', async () => {
    _setAppleFoundationForTesting({ probe: () => Promise.reject(new Error('spawn failed')) });
    expect(await isAppleFoundationAvailable()).toBe(false);
  });

  it('caches the result (probe runs once)', async () => {
    let calls = 0;
    _setAppleFoundationForTesting({ probe: () => { calls++; return Promise.resolve({ available: true }); } });
    await isAppleFoundationAvailable();
    await isAppleFoundationAvailable();
    expect(calls).toBe(1);
  });
});

describe('runAppleFoundationSummarize', () => {
  const SCHEMA = { type: 'object', properties: { entries: { type: 'array' } } };

  it('passes {system, prompt, schema} to apple-fm generate and returns its output', async () => {
    let seen: unknown = null;
    _setAppleFoundationForTesting({
      generate: (req) => { seen = req; return Promise.resolve('{"entries":[]}'); },
    });
    const out = await runAppleFoundationSummarize('SYS', 'MAT', SCHEMA);
    expect(out).toBe('{"entries":[]}');
    expect(seen).toEqual({ system: 'SYS', prompt: 'MAT', schema: SCHEMA });
  });

  it('propagates a generation failure so the caller can fall back', async () => {
    _setAppleFoundationForTesting({
      generate: () => Promise.reject(new Error('[exceededContextWindowSize] too long')),
    });
    await expect(runAppleFoundationSummarize('s', 'm', SCHEMA)).rejects.toThrow(/exceededContextWindowSize/);
  });
});

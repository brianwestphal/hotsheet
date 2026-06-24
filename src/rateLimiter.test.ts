import { describe, expect, it } from 'vitest';

import { createRateLimiter } from './rateLimiter.js';

describe('createRateLimiter', () => {
  it('allows up to max hits then rejects within the window', () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 3 });
    expect(rl.tryConsume('a', 0)).toBe(true);
    expect(rl.tryConsume('a', 10)).toBe(true);
    expect(rl.tryConsume('a', 20)).toBe(true);
    expect(rl.tryConsume('a', 30)).toBe(false); // 4th in-window → rejected
  });

  it('tracks keys independently', () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 1 });
    expect(rl.tryConsume('a', 0)).toBe(true);
    expect(rl.tryConsume('b', 0)).toBe(true); // different key, own budget
    expect(rl.tryConsume('a', 1)).toBe(false);
  });

  it('frees budget as hits fall out of the trailing window', () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 2 });
    expect(rl.tryConsume('a', 0)).toBe(true);
    expect(rl.tryConsume('a', 500)).toBe(true);
    expect(rl.tryConsume('a', 900)).toBe(false);   // 2 still in window
    expect(rl.tryConsume('a', 1100)).toBe(true);   // the t=0 hit expired
  });

  it('prune drops expired keys', () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 5 });
    rl.tryConsume('a', 0);
    rl.tryConsume('b', 0);
    expect(rl.size()).toBe(2);
    rl.prune(2000); // both windows expired
    expect(rl.size()).toBe(0);
  });

  it('rejects nonsensical options', () => {
    expect(() => createRateLimiter({ windowMs: 0, max: 1 })).toThrow();
    expect(() => createRateLimiter({ windowMs: 1, max: 0 })).toThrow();
  });
});

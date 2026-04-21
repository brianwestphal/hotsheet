import { describe, expect, it } from 'vitest';

import { RingBuffer } from './ringBuffer.js';

describe('RingBuffer', () => {
  it('keeps all bytes when under the limit', () => {
    const rb = new RingBuffer(64);
    rb.push(Buffer.from('hello'));
    rb.push(Buffer.from(' world'));
    expect(rb.size()).toBe(11);
    expect(rb.snapshot().toString()).toBe('hello world');
  });

  it('drops oldest bytes when the limit is exceeded', () => {
    const rb = new RingBuffer(5);
    rb.push(Buffer.from('abcde'));
    rb.push(Buffer.from('fghij'));
    expect(rb.size()).toBe(5);
    expect(rb.snapshot().toString()).toBe('fghij');
  });

  it('partially trims the head chunk when the overflow is smaller than it', () => {
    const rb = new RingBuffer(5);
    rb.push(Buffer.from('abcde'));
    rb.push(Buffer.from('XY'));
    // Expected: drop first 2 bytes of 'abcde' then append 'XY' → 'cdeXY'
    expect(rb.snapshot().toString()).toBe('cdeXY');
  });

  it('handles a single push larger than the limit', () => {
    const rb = new RingBuffer(3);
    rb.push(Buffer.from('abcdefg'));
    expect(rb.size()).toBe(3);
    expect(rb.snapshot().toString()).toBe('efg');
  });

  it('ignores empty pushes', () => {
    const rb = new RingBuffer(16);
    rb.push(Buffer.alloc(0));
    expect(rb.size()).toBe(0);
    expect(rb.snapshot().length).toBe(0);
  });

  it('clear() resets state', () => {
    const rb = new RingBuffer(16);
    rb.push(Buffer.from('hello'));
    rb.clear();
    expect(rb.size()).toBe(0);
    expect(rb.snapshot().length).toBe(0);
  });

  it('rejects zero or negative max', () => {
    expect(() => new RingBuffer(0)).toThrow();
    expect(() => new RingBuffer(-1)).toThrow();
  });
});

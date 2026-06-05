/**
 * §78 Announcer live mode (HS-8750 2a) — debounce/coalesce timing, driven by a
 * fake clock so the windows are exercised deterministically.
 */
import { describe, expect, it } from 'vitest';

import { CoalescingTrigger, type TriggerClock } from './coalescingTrigger.js';

class FakeClock implements TriggerClock {
  private t = 0;
  private nextId = 1;
  private timers: { id: number; fireAt: number; cb: () => void }[] = [];
  now(): number { return this.t; }
  setTimer(ms: number, cb: () => void): unknown { const id = this.nextId++; this.timers.push({ id, fireAt: this.t + ms, cb }); return id; }
  clearTimer(handle: unknown): void { this.timers = this.timers.filter(x => x.id !== handle); }
  advance(ms: number): void {
    this.t += ms;
    const due = this.timers.filter(x => x.fireAt <= this.t).sort((a, b) => a.fireAt - b.fireAt);
    this.timers = this.timers.filter(x => x.fireAt > this.t);
    for (const x of due) x.cb();
  }
}

describe('CoalescingTrigger (HS-8750)', () => {
  it('fires once after the quiet window with no new pings', () => {
    const clock = new FakeClock();
    let fires = 0;
    const t = new CoalescingTrigger({ quietMs: 5000, maxWaitMs: 25000, onFire: () => { fires++; }, clock });
    t.ping();
    clock.advance(4999);
    expect(fires).toBe(0);     // quiet window not elapsed
    clock.advance(1);
    expect(fires).toBe(1);     // fired at +5000
    expect(t.isPending()).toBe(false);
  });

  it('coalesces a burst — each ping resets the quiet window', () => {
    const clock = new FakeClock();
    let fires = 0;
    const t = new CoalescingTrigger({ quietMs: 5000, maxWaitMs: 25000, onFire: () => { fires++; }, clock });
    t.ping();
    clock.advance(3000); t.ping(); // resets quiet to fire at 8000
    clock.advance(3000);           // t=6000, no fire yet
    expect(fires).toBe(0);
    clock.advance(2000);           // t=8000 → fire
    expect(fires).toBe(1);
  });

  it('respects the max-wait cap during a continuous burst', () => {
    const clock = new FakeClock();
    let fires = 0;
    const t = new CoalescingTrigger({ quietMs: 5000, maxWaitMs: 25000, onFire: () => { fires++; }, clock });
    // Ping every 4s (< quiet) so the quiet window keeps resetting; the max-wait
    // cap (25s from the first ping) must force a fire anyway.
    t.ping();
    for (let elapsed = 0; elapsed < 25000; elapsed += 4000) {
      clock.advance(4000);
      if (clock.now() < 25000) t.ping();
    }
    expect(fires).toBe(1); // fired at the 25s cap, not later
  });

  it('dispose cancels a pending fire', () => {
    const clock = new FakeClock();
    let fires = 0;
    const t = new CoalescingTrigger({ quietMs: 5000, maxWaitMs: 25000, onFire: () => { fires++; }, clock });
    t.ping();
    t.dispose();
    clock.advance(10000);
    expect(fires).toBe(0);
    expect(t.isPending()).toBe(false);
  });
});

/**
 * §78 Announcer live mode (HS-8750 2a) — debounce + coalesce timing.
 *
 * Work lands in bursts (several edits, a test run, a completion note within
 * seconds); narration is far slower. This trigger turns a burst of `ping()`s
 * into ONE `onFire()` — it fires after a **quiet window** with no new pings, but
 * never waits longer than a **max-wait cap** since the first ping of the burst
 * (so a long continuous burst still surfaces). Pure + clock-injectable so the
 * timing is unit-tested with a fake clock rather than real `setTimeout`.
 */
export interface TriggerClock {
  now(): number;
  setTimer(ms: number, cb: () => void): unknown;
  clearTimer(handle: unknown): void;
}

const realClock: TriggerClock = {
  now: () => Date.now(),
  setTimer: (ms, cb) => setTimeout(cb, ms),
  clearTimer: (h) => { clearTimeout(h as ReturnType<typeof setTimeout>); },
};

export interface CoalescingTriggerOptions {
  /** Fire this long after the last `ping()` with no new ping. */
  quietMs: number;
  /** …but never longer than this after the FIRST ping of the burst. */
  maxWaitMs: number;
  onFire: () => void;
  clock?: TriggerClock;
}

export class CoalescingTrigger {
  private readonly clock: TriggerClock;
  private firstPingAt: number | null = null;
  private timer: unknown = null;

  constructor(private readonly opts: CoalescingTriggerOptions) {
    this.clock = opts.clock ?? realClock;
  }

  /** Record a change. (Re)schedules the fire to `min(lastPing + quiet, firstPing + maxWait)`. */
  ping(): void {
    const now = this.clock.now();
    this.firstPingAt ??= now;
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    const fireAt = Math.min(now + this.opts.quietMs, this.firstPingAt + this.opts.maxWaitMs);
    const delay = Math.max(0, fireAt - now);
    this.timer = this.clock.setTimer(delay, () => { this.fire(); });
  }

  private fire(): void {
    this.timer = null;
    this.firstPingAt = null;
    this.opts.onFire();
  }

  /** True while a burst is pending (between the first ping and the fire). */
  isPending(): boolean {
    return this.firstPingAt !== null;
  }

  /** Cancel any pending fire (e.g. no live listeners left). */
  dispose(): void {
    if (this.timer !== null) this.clock.clearTimer(this.timer);
    this.timer = null;
    this.firstPingAt = null;
  }
}

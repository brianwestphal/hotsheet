/**
 * §78 Announcer live mode 2b (HS-8767) — the client consumer.
 *
 * While "Live" is on in the PIP, this keeps the per-project live **lease**
 * renewed (so the §80 server generator keeps producing) and **tails** the
 * announcements queue, appending genuinely-new entries to the player as they
 * appear. It also surfaces the "still working" presence (any live project busy).
 *
 * Kept DOM-free + timer-injectable so the renewal / poll / dedup logic is
 * unit-tested with fakes; the PIP wires the real typed-API fetchers + the
 * channel busy reader.
 */
import type { ReelEntry } from './announcerPip.js';

/** Poll the queue this often while live (cheap; live mode is on only while listening). */
const POLL_MS = 3000;
/** Renew the lease this often — comfortably under the 90 s server TTL. */
const RENEW_MS = 30000;

export interface LiveSessionDeps {
  /** The live projects (the current context's enabled projects). */
  projectSecrets: string[];
  /** Fetch a project's current entries, annotated with project identity. */
  fetchEntries: (secret: string) => Promise<ReelEntry[]>;
  /** Register/renew (true) or drop (false) a project's live lease. */
  setLive: (enabled: boolean, secret: string) => Promise<unknown>;
  /** Whether any of the live projects is "working" right now (§12 busy). */
  isBusy: (secrets: readonly string[]) => boolean;
  /** Deliver newly-seen entries (deduped, oldest-first). */
  onNewEntries: (entries: ReelEntry[]) => void;
  /** Presence changed — true while any live project is working. */
  onPresence: (busy: boolean) => void;
  /** Pause renew + poll while the window is hidden (default: document-based). */
  isVisible?: () => boolean;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/** Stable dedup key for an entry (ids aren't unique across projects). */
function entryKey(e: ReelEntry): string { return `${e.projectSecret}:${String(e.id)}`; }

export class LiveSession {
  private readonly seen = new Set<string>();
  private pollTimer: unknown = null;
  private renewTimer: unknown = null;
  private stopped = false;
  private readonly isVisible: () => boolean;
  private readonly setTimer: (cb: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly deps: LiveSessionDeps) {
    this.isVisible = deps.isVisible ?? (() => typeof document === 'undefined' || document.visibilityState === 'visible');
    this.setTimer = deps.setTimer ?? ((cb, ms) => setInterval(cb, ms));
    this.clearTimer = deps.clearTimer ?? ((h) => { clearInterval(h as ReturnType<typeof setInterval>); });
  }

  /** Seed already-known entry keys (the catch-up reel already in the player) so
   *  they aren't re-appended when the first poll runs. */
  seed(entries: readonly ReelEntry[]): void {
    for (const e of entries) this.seen.add(entryKey(e));
  }

  /** Register the leases and start the renew + poll timers. */
  async start(): Promise<void> {
    this.stopped = false;
    await this.renew();
    await this.poll();
    this.renewTimer = this.setTimer(() => { void this.renew(); }, RENEW_MS);
    this.pollTimer = this.setTimer(() => { void this.poll(); }, POLL_MS);
  }

  /** Drop the leases and stop the timers. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.pollTimer !== null) this.clearTimer(this.pollTimer);
    if (this.renewTimer !== null) this.clearTimer(this.renewTimer);
    this.pollTimer = null;
    this.renewTimer = null;
    for (const secret of this.deps.projectSecrets) {
      await Promise.resolve(this.deps.setLive(false, secret)).catch(() => { /* best-effort */ });
    }
  }

  private async renew(): Promise<void> {
    if (this.stopped || !this.isVisible()) return; // backgrounded → let the lease lapse
    for (const secret of this.deps.projectSecrets) {
      await Promise.resolve(this.deps.setLive(true, secret)).catch(() => { /* best-effort */ });
    }
  }

  /** Fetch + append any new entries, and refresh presence. Exposed for the
   *  PIP to call on demand (e.g. when the window becomes visible again). */
  async poll(): Promise<void> {
    if (this.stopped || !this.isVisible()) return;
    const fresh: ReelEntry[] = [];
    for (const secret of this.deps.projectSecrets) {
      try {
        for (const e of await this.deps.fetchEntries(secret)) {
          const k = entryKey(e);
          if (!this.seen.has(k)) { this.seen.add(k); fresh.push(e); }
        }
      } catch { /* transient — try again next tick */ }
    }
    if (fresh.length > 0) {
      fresh.sort((a, b) => a.created_at.localeCompare(b.created_at));
      this.deps.onNewEntries(fresh);
    }
    this.deps.onPresence(this.deps.isBusy(this.deps.projectSecrets));
  }
}

/**
 * HS-9527 — guarded filesystem access for the backup root (`backupDir`).
 *
 * `backupDir` is user-configurable and is COMMONLY pointed at iCloud Drive,
 * Google Drive, Dropbox, or a network share — that is a normal, supported
 * configuration, not a misuse. On macOS those paths are File Provider
 * extensions: every operation is an XPC round-trip to a daemon, it can block
 * for an unbounded time, and **there is no kernel-level timeout**. The app must
 * keep working when the backup filesystem is slow, wedged, or gone for hours.
 *
 * Two hard rules follow, and this module exists to enforce both.
 *
 * **1. Never call a synchronous `fs` function on the backup root.**
 * A sync call blocks the main event loop inside `read(2)` with nothing able to
 * interrupt it. Measured on a live Google Drive `backupDir` with the machine
 * otherwise idle: a 134 KB `readFileSync` averaged 686 ms (2.6 s worst), and the
 * 29-manifest startup scan blocked for **19.9 s straight**. Past 60 s the §45
 * watchdog SIGKILLs the server — which it did four times on 2026-07-31.
 *
 * **2. Async `fs` alone is NOT sufficient.**
 * `fs.promises` moves the work to libuv's threadpool, which is **four threads by
 * default** and is shared with every other file, DNS, and zlib user in the
 * process. Four wedged backup reads therefore starve *all* file I/O app-wide —
 * a slower death than a wedged loop, not a cure for it. So every backup-root
 * operation additionally goes through:
 *
 *   - a **concurrency gate** (`maxInflight`, default 2) so backup work can
 *     never occupy more than half the threadpool, leaving the rest of the app
 *     with threads to run on even in the worst case;
 *   - a **deadline** per operation, covering queue wait + execution. Note what
 *     a timeout can and cannot do: it releases the *caller*, but the underlying
 *     libuv request keeps running and keeps holding its thread until the kernel
 *     returns. Bounding the wait is what keeps callers responsive; bounding the
 *     concurrency is what keeps the damage contained. Both are required;
 *   - a **circuit breaker**. After `failureThreshold` consecutive deadline
 *     misses the root is marked unreachable and every subsequent call fails
 *     fast with `BackupFsUnavailableError` **without touching the filesystem at
 *     all**, until a backoff elapses and a single probe is let through.
 *     This is the part that makes an unreachable backup folder cost nothing.
 *
 * ## Contract for callers
 *
 * Unavailability is a **normal outcome, never an error to propagate**. Backups
 * are best-effort by construction: the live database lives in `<dataDir>/db`
 * and is never on the backup filesystem, so a missed backup tick costs a backup,
 * not data. Callers skip the tick, leave state untouched, and try again later —
 * see `tolerateOutage`.
 *
 * Only deadline misses trip the breaker. `ENOENT` and friends are *answers*,
 * not failures: they come back fast and mean the filesystem is working fine.
 *
 * Everything is env-tunable for the pathological case (§ Tunables below).
 */

import { promises as fsp, type Stats } from 'fs';

/** Thrown instead of touching the filesystem while a root's breaker is open,
 *  and when an operation misses its deadline. Callers should treat it as
 *  "skip this work, the backup filesystem is not answering right now". */
export class BackupFsUnavailableError extends Error {
  readonly code = 'EBACKUPFS_UNAVAILABLE';
  readonly root: string;
  constructor(root: string, reason: string) {
    super(`Backup filesystem unavailable (${root}): ${reason}`);
    this.name = 'BackupFsUnavailableError';
    this.root = root;
  }
}

/** True when `err` is this module's unavailability signal. Use it to
 *  distinguish "the backup filesystem is not answering" (skip, retry later)
 *  from a real bug (surface it). */
export function isBackupFsUnavailable(err: unknown): err is BackupFsUnavailableError {
  return err instanceof BackupFsUnavailableError;
}

// ---------------------------------------------------------------- tunables

// Read on EVERY use rather than captured at module load. Two reasons: an
// operator can retune a running server, and tests can shrink the deadlines
// without `vi.resetModules()` gymnastics — the alternative is a unit suite that
// genuinely waits out three 15 s stalls per case.
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Max backup-root operations in libuv's threadpool at once. Default 2 of the
 *  pool's 4 threads, so the rest of the app always has somewhere to run even if
 *  every backup op is wedged. */
const maxInflight = (): number => envInt('HOTSHEET_BACKUP_FS_MAX_INFLIGHT', 2);

/** Deadline for metadata operations (`stat`, `readdir`, `access`, `mkdir`,
 *  `rm`, `rename`). Metadata is cached by File Provider daemons and answers in
 *  ~0 ms when healthy, so a generous bound still catches a real stall. */
const metaTimeoutMs = (): number => envInt('HOTSHEET_BACKUP_FS_META_TIMEOUT_MS', 15_000);

/** Deadline for content operations (`readFile`, `writeFile`, `copyFile`,
 *  `link`). Deliberately much larger: a 10 MB tarball write to a cloud folder
 *  legitimately takes tens of seconds, and killing a healthy-but-slow upload
 *  would be worse than waiting for it. */
const ioTimeoutMs = (): number => envInt('HOTSHEET_BACKUP_FS_IO_TIMEOUT_MS', 120_000);

/** Consecutive deadline misses before a root is declared unreachable. */
const failureThreshold = (): number => envInt('HOTSHEET_BACKUP_FS_FAILURE_THRESHOLD', 3);

/** Backoff ladder while a root is unreachable; the last rung repeats. Long on
 *  purpose — a cloud folder that has been dead for ten minutes is usually still
 *  dead, and each probe costs a threadpool thread for the duration. */
const BACKOFF_LADDER_MS = [30_000, 60_000, 300_000, 900_000];

// ------------------------------------------------------------ breaker state

type BreakerState = 'closed' | 'open' | 'half-open';

interface RootState {
  consecutiveTimeouts: number;
  /** Epoch ms until which the breaker stays open. 0 when closed. */
  openUntil: number;
  /** Index into `BACKOFF_LADDER_MS` for the next open period. */
  backoffLevel: number;
  /** A half-open probe is in flight; other callers keep failing fast. */
  probeInFlight: boolean;
  /** Set when the breaker opens, cleared when it closes — so the "backup
   *  filesystem went away / came back" transitions log exactly once each. */
  reportedOpen: boolean;
  lastReason: string;
  stats: { ok: number; timedOut: number; failedFast: number };
}

/** Reachability is a property of one root, so the BREAKER is per-root: one
 *  project's dead cloud folder must not pause backups for a project on local
 *  disk. */
const roots = new Map<string, RootState>();

/** The threadpool is a property of the PROCESS, so the GATE is global. Four
 *  roots each allowed two in-flight operations would put eight requests into a
 *  four-thread pool and starve everything else — exactly what the cap exists to
 *  prevent. */
const gate = {
  inFlight: 0,
  waiters: [] as Array<() => void>,
  /**
   * Operations that missed their deadline and were released for ADMISSION
   * purposes while their libuv thread is still, as far as we know, stuck in the
   * kernel. Tracked (and logged) but deliberately NOT counted against
   * `maxInflight`.
   *
   * Counting them would be the more conservative-looking choice and it is
   * wrong: two permanently wedged operations would pin the gate at zero free
   * slots forever, so the half-open probe could never run, so the breaker could
   * never close, so backups would stay dead until a restart even after the
   * cloud folder came back. Deadlock disguised as caution.
   *
   * What actually bounds the leak is the breaker: while it is open NOTHING
   * runs, and each open period admits exactly one probe. So leaked threads grow
   * by at most one per backoff window (30 s → 60 s → 5 min → 15 min), not one
   * per call. In practice they are not leaked at all — a File Provider that
   * recovers returns its pending reads.
   */
  leaked: 0,
};

function stateFor(root: string): RootState {
  let s = roots.get(root);
  if (s === undefined) {
    s = {
      consecutiveTimeouts: 0,
      openUntil: 0,
      backoffLevel: 0,
      probeInFlight: false,
      reportedOpen: false,
      lastReason: '',
      stats: { ok: 0, timedOut: 0, failedFast: 0 },
    };
    roots.set(root, s);
  }
  return s;
}

function breakerState(s: RootState, now: number): BreakerState {
  if (s.openUntil === 0) return 'closed';
  return now >= s.openUntil ? 'half-open' : 'open';
}

function onTimeout(root: string, s: RootState, reason: string): void {
  s.stats.timedOut++;
  s.consecutiveTimeouts++;
  s.lastReason = reason;
  if (s.consecutiveTimeouts < failureThreshold() && s.openUntil === 0) return;
  // Threshold reached, or a half-open probe failed → (re-)open with the next
  // rung of the ladder.
  const wait = BACKOFF_LADDER_MS[Math.min(s.backoffLevel, BACKOFF_LADDER_MS.length - 1)];
  s.openUntil = Date.now() + wait;
  s.backoffLevel++;
  if (!s.reportedOpen) {
    s.reportedOpen = true;
    console.warn(
      `[backupFs] backup filesystem at ${root} is not responding (${reason}). ` +
      `Backups are paused; the app is unaffected. Retrying in ${Math.round(wait / 1000)}s.`,
    );
  }
}

function onSuccess(root: string, s: RootState): void {
  s.stats.ok++;
  s.consecutiveTimeouts = 0;
  if (s.openUntil !== 0 || s.backoffLevel !== 0) {
    s.openUntil = 0;
    s.backoffLevel = 0;
    if (s.reportedOpen) {
      s.reportedOpen = false;
      console.warn(`[backupFs] backup filesystem at ${root} is responding again; backups resumed.`);
    }
  }
}

// ------------------------------------------------------------ the gate + run

/** Acquire a threadpool slot, or reject if the deadline passes first. */
function acquire(deadline: number): Promise<void> {
  if (gate.inFlight < maxInflight()) {
    gate.inFlight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const idx = gate.waiters.indexOf(grant);
      if (idx !== -1) gate.waiters.splice(idx, 1);
      reject(new Error('queued behind a stalled backup-filesystem operation'));
    }, Math.max(0, deadline - Date.now()));
    // Never let a queued waiter hold the process open.
    if (typeof timer.unref === 'function') timer.unref();
    function grant(): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      gate.inFlight++;
      resolve();
    }
    gate.waiters.push(grant);
  });
}

function release(): void {
  gate.inFlight--;
  const next = gate.waiters.shift();
  if (next !== undefined) next();
}

/**
 * Run one filesystem operation against `root` under the gate, the deadline, and
 * the breaker.
 */
async function guarded<T>(root: string, label: string, timeoutMs: number, op: () => Promise<T>): Promise<T> {
  const s = stateFor(root);
  const now = Date.now();
  const bs = breakerState(s, now);

  if (bs === 'open' || (bs === 'half-open' && s.probeInFlight)) {
    s.stats.failedFast++;
    throw new BackupFsUnavailableError(root, `circuit open (${s.lastReason})`);
  }
  const isProbe = bs === 'half-open';
  if (isProbe) s.probeInFlight = true;

  const deadline = now + timeoutMs;
  try {
    // The half-open probe SKIPS the queue. It is one operation, `probeInFlight`
    // already limits it to one per root, and it is the only path back to a
    // working state — making it wait behind whatever wedged the gate in the
    // first place is how recovery never happens.
    if (!isProbe) {
      try {
        await acquire(deadline);
      } catch (queueErr) {
        onTimeout(root, s, `${label}: ${queueErr instanceof Error ? queueErr.message : String(queueErr)}`);
        throw new BackupFsUnavailableError(root, `${label} could not start within ${timeoutMs}ms`);
      }
    } else {
      gate.inFlight++;
    }

    // Slot accounting: released when `raw` settles, OR handed to `gate.leaked`
    // if the deadline passes first (see `gate.leaked` for why it is not simply
    // held). Exactly one of the two happens, and `raw` settling later undoes
    // whichever it was.
    let slotReleased = false;
    const releaseSlot = (): void => {
      if (slotReleased) return;
      slotReleased = true;
      release();
    };
    const raw = op();
    const onRawSettled = (): void => {
      if (slotReleased) gate.leaked--; // came back after all
      else releaseSlot();
    };
    void raw.then(onRawSettled, onRawSettled);
    // Swallow the late rejection separately: the caller may have already walked
    // away, and an unhandled rejection would take the process down.
    void raw.catch(() => { /* reported to the caller below when it is still waiting */ });

    // Held in a box, and matched by IDENTITY below. "Is this rejection our
    // deadline?" has an exact answer — we either created that error or we
    // didn't — and identity gives it without having to guess from the error's
    // type, which would misread a nested guard's unavailability as our own.
    const expired: { err: BackupFsUnavailableError | null } = { err: null };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          expired.err = new BackupFsUnavailableError(root, `${label} exceeded ${timeoutMs}ms`);
          reject(expired.err);
        },
        Math.max(0, deadline - Date.now()),
      );
      if (typeof timer.unref === 'function') timer.unref();
    });

    try {
      const result = await Promise.race([raw, expiry]);
      onSuccess(root, s);
      return result;
    } catch (err) {
      if (err === expired.err) {
        // A genuine deadline miss — the filesystem is not answering.
        gate.leaked++;
        releaseSlot();
        onTimeout(root, s, `${label} exceeded ${timeoutMs}ms`);
        throw err;
      }
      // The operation ANSWERED, with an error (ENOENT, EACCES, malformed…).
      // That is a healthy filesystem giving a real reply, so it must not trip
      // the breaker; conflating the two is how a missing file would take
      // backups offline for fifteen minutes.
      onSuccess(root, s);
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } finally {
    if (isProbe) s.probeInFlight = false;
  }
}

// ------------------------------------------------------------------ the API

/** Guarded async filesystem operations, bound to one backup root. Obtain via
 *  `backupFsFor(root)`. Every method may reject with `BackupFsUnavailableError`;
 *  everything else is an ordinary `fs` error. */
export interface BackupFs {
  readonly root: string;
  /** `true` / `false` — never throws for a missing path. Rejects only when the
   *  filesystem itself is unavailable. */
  exists(path: string): Promise<boolean>;
  /** `exists`, but an unavailable filesystem reads as `false` rather than
   *  throwing. For guard clauses where "can't tell" and "not there" lead to the
   *  same skip. */
  existsOrUnknown(path: string): Promise<boolean>;
  /** `Buffer<ArrayBuffer>` — the same `NonSharedBuffer` `fs.promises.readFile`
   *  returns. Declaring plain `Buffer` here would widen it to
   *  `Buffer<ArrayBufferLike>` and break every `new Blob([buf])` call site. */
  readFile(path: string): Promise<Buffer<ArrayBuffer>>;
  readFileUtf8(path: string): Promise<string>;
  writeFile(path: string, data: string | Buffer): Promise<void>;
  readdir(path: string): Promise<string[]>;
  /** `readdir`, but a missing directory reads as `[]`. */
  readdirOrEmpty(path: string): Promise<string[]>;
  stat(path: string): Promise<Stats>;
  mkdir(path: string): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
  /** `rm` with `force`, swallowing every ordinary error — the "best-effort
   *  delete" idiom this codebase uses in `finally` blocks. Unavailability is
   *  swallowed too: an undeleted file on an unreachable filesystem is not
   *  something the caller can act on. */
  rmBestEffort(path: string, opts?: { recursive?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
  link(from: string, to: string): Promise<void>;
  access(path: string): Promise<void>;
  /**
   * Escape hatch for a COMPOSITE operation that must be guarded as one unit —
   * e.g. the open/write/fsync/close/rename dance behind an atomic write, where
   * guarding each step separately would let the sequence interleave with other
   * backup work and would charge the gate five times for one logical write.
   * `kind` picks the deadline: `'io'` for anything that moves bytes.
   */
  run<T>(label: string, kind: 'meta' | 'io', op: () => Promise<T>): Promise<T>;
}

/** A `BackupFs` bound to `root`. Breaker state is shared per root across
 *  callers, which is the point — one project's stalled GC teaches every other
 *  caller on the same folder to stop trying. */
export function backupFsFor(root: string): BackupFs {
  const meta = <T>(label: string, op: () => Promise<T>): Promise<T> => guarded(root, label, metaTimeoutMs(), op);
  const io = <T>(label: string, op: () => Promise<T>): Promise<T> => guarded(root, label, ioTimeoutMs(), op);

  const api: BackupFs = {
    root,
    async exists(path) {
      try {
        await meta('access', () => fsp.access(path));
        return true;
      } catch (err) {
        if (isBackupFsUnavailable(err)) throw err;
        return false;
      }
    },
    async existsOrUnknown(path) {
      try { return await api.exists(path); }
      catch { return false; }
    },
    readFile: (path) => io('readFile', () => fsp.readFile(path)),
    readFileUtf8: (path) => io('readFile', () => fsp.readFile(path, 'utf-8')),
    writeFile: (path, data) => io('writeFile', () => fsp.writeFile(path, data)),
    readdir: (path) => meta('readdir', () => fsp.readdir(path)),
    async readdirOrEmpty(path) {
      try { return await api.readdir(path); }
      catch (err) {
        if (isBackupFsUnavailable(err)) throw err;
        return [];
      }
    },
    stat: (path) => meta('stat', () => fsp.stat(path)),
    mkdir: async (path) => { await meta('mkdir', () => fsp.mkdir(path, { recursive: true })); },
    rm: async (path, opts) => { await meta('rm', () => fsp.rm(path, { force: true, recursive: opts?.recursive ?? false })); },
    async rmBestEffort(path, opts) {
      try { await api.rm(path, opts); } catch { /* best effort by contract */ }
    },
    rename: (from, to) => meta('rename', () => fsp.rename(from, to)),
    copyFile: (from, to) => io('copyFile', () => fsp.copyFile(from, to)),
    link: (from, to) => io('link', () => fsp.link(from, to)),
    access: (path) => meta('access', () => fsp.access(path)),
    run: (label, kind, op) => guarded(root, label, kind === 'io' ? ioTimeoutMs() : metaTimeoutMs(), op),
  };
  return api;
}

/**
 * Run `fn`; if the backup filesystem turns out to be unavailable, log once at
 * debug volume and return `fallback` instead of propagating. This is the
 * standard wrapper for periodic backup work — a paused backup tick is an
 * expected state, not an incident.
 */
export async function tolerateOutage<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isBackupFsUnavailable(err)) {
      // The breaker already logged the transition; per-call noise would bury it.
      return fallback;
    }
    throw err;
  }
}

/** Health snapshot for diagnostics / the Settings UI. Pure read — never
 *  touches the filesystem. */
export function getBackupFsHealth(root: string): {
  state: BreakerState;
  available: boolean;
  inFlight: number;
  queued: number;
  /** Operations still stuck in the kernel past their deadline. A non-zero value
   *  that never drops means the filesystem is not just slow but hung. */
  leaked: number;
  retryInMs: number;
  lastReason: string;
  stats: { ok: number; timedOut: number; failedFast: number };
} {
  const s = stateFor(root);
  const now = Date.now();
  const state = breakerState(s, now);
  return {
    state,
    available: state !== 'open',
    // Gate counters are process-wide (see `gate`), so these describe backup
    // filesystem pressure overall, not this root's share of it.
    inFlight: gate.inFlight,
    queued: gate.waiters.length,
    leaked: gate.leaked,
    retryInMs: state === 'open' ? s.openUntil - now : 0,
    lastReason: s.lastReason,
    stats: { ...s.stats },
  };
}

/** Cheap pre-check so a caller can skip assembling expensive work (a DB query,
 *  a manifest build) when the destination is known to be down. Advisory only —
 *  the guard on each operation is what actually enforces it. */
export function isBackupFsAvailable(root: string): boolean {
  return breakerState(stateFor(root), Date.now()) !== 'open';
}

/** Test seam — drop all breaker + gate state. */
export function _resetBackupFsForTests(): void {
  roots.clear();
  gate.inFlight = 0;
  gate.waiters.length = 0;
  gate.leaked = 0;
}

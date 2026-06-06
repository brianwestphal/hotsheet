/**
 * §78 Announcer live mode (HS-8750 2a) — the server-side generator.
 *
 * Producer half of the §78.4.1 producer/consumer design. While at least one
 * client is **actively listening live**, it watches the global `change-version`
 * (the same signal the UI long-poll uses), coalesces bursts into one batch
 * (`CoalescingTrigger`), and runs `generateAnnouncementsOnce` for each live
 * project in its own DB context. The consumer (the PIP draining new rows) is
 * HS-8767 (2b).
 *
 * **Off unless listening.** Generation only runs for a project that holds a live
 * **lease** — a TTL the client renews on its poll cadence (POST
 * /api/announcer/live). If a window closes / crashes / backgrounds and stops
 * renewing, the lease expires and generation stops, so it can never silently
 * spend the user's API key in the background. The change-version is GLOBAL
 * (wiring caveat a), so each pass re-queries every live project's signals since
 * that project's own cursor.
 */
import { runWithDataDir } from '../db/connection.js';
import { addPollWaiter } from '../routes/notify.js';
import { tryConsumeCall } from './callBudget.js';
import { CoalescingTrigger } from './coalescingTrigger.js';
import { generateAnnouncementsOnce, isAnnouncerEnabled, prepareSummarizationProvider, resolveAnnouncerModel } from './generate.js';

/** How long a single live-listen registration lasts without renewal. */
export const LIVE_LEASE_MS = 90_000;
/** Debounce window — fire this long after the last change with no new change. */
const QUIET_MS = 5_000;
/** Coalesce cap — never wait longer than this after the first change of a burst. */
const MAX_WAIT_MS = 25_000;

interface Lease { dataDir: string; expiresAt: number }
const leases = new Map<string, Lease>(); // keyed by project secret

let trigger: CoalescingTrigger | null = null;
let subscribed = false;
/** Test seam — the live generation pass (overridable so the wiring can be
 *  exercised without a real DB / Anthropic call). */
let runPass: () => Promise<void> = runGenerationPass;

/** Register / renew a project's live-listen lease, and start the loop. */
export function registerLiveListener(secret: string, dataDir: string, now: number = Date.now()): void {
  leases.set(secret, { dataDir, expiresAt: now + LIVE_LEASE_MS });
  ensureRunning();
}

/** Drop a project's live lease immediately (explicit "stop listening"). */
export function unregisterLiveListener(secret: string): void {
  leases.delete(secret);
}

/** Live projects with a non-expired lease (prunes expired ones in passing). */
export function getLiveProjects(now: number = Date.now()): { secret: string; dataDir: string }[] {
  const out: { secret: string; dataDir: string }[] = [];
  for (const [secret, lease] of leases) {
    if (lease.expiresAt <= now) { leases.delete(secret); continue; }
    out.push({ secret, dataDir: lease.dataDir });
  }
  return out;
}

/** Whether a specific project is currently live (lease present + unexpired). */
export function isLive(secret: string, now: number = Date.now()): boolean {
  const lease = leases.get(secret);
  if (lease === undefined) return false;
  if (lease.expiresAt <= now) { leases.delete(secret); return false; }
  return true;
}

// --- Loop wiring ---

function ensureRunning(): void {
  if (subscribed) return;
  subscribed = true;
  trigger ??= new CoalescingTrigger({ quietMs: QUIET_MS, maxWaitMs: MAX_WAIT_MS, onFire: () => { void runPass(); } });
  subscribeNext();
}

function subscribeNext(): void {
  if (getLiveProjects().length === 0) { stopLoop(); return; }
  // One-shot waiter (notify.ts clears the list on each wake); re-arm after each.
  addPollWaiter(() => {
    if (getLiveProjects().length === 0) { stopLoop(); return; }
    trigger?.ping();
    subscribeNext();
  });
}

function stopLoop(): void {
  subscribed = false;
  trigger?.dispose();
  trigger = null;
}

async function runGenerationPass(): Promise<void> {
  for (const { secret, dataDir } of getLiveProjects()) {
    try {
      await runWithDataDir(dataDir, async () => {
        if (!(await isAnnouncerEnabled())) return;
        // HS-8790/8792 — pick the model (on-device default when available), then
        // gate via the shared provider-readiness check (Anthropic key / Apple
        // helper / local endpoint). Not ready → skip this project this pass.
        const model = await resolveAnnouncerModel();
        const { ready, apiKey } = await prepareSummarizationProvider(model);
        if (!ready) return;
        await generateAnnouncementsOnce({
          dataDir, projectSecret: secret, apiKey, model,
          canSummarize: () => tryConsumeCall(secret, Date.now()), // HS-8770 budget
        });
      });
    } catch (err) {
      // A live pass must never crash the loop — log and move on.
      console.error(`[announcer] live generation failed for project ${secret}:`, err);
    }
  }
}

/** **TEST ONLY** — reset registry + loop state and (optionally) stub the pass. */
export function _resetLiveGeneratorForTesting(passOverride?: () => Promise<void>): void {
  leases.clear();
  trigger?.dispose();
  trigger = null;
  subscribed = false;
  runPass = passOverride ?? runGenerationPass;
}

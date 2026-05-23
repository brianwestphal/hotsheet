/**
 * HS-8570 — memory / stability over time.
 *
 * Hot Sheet sessions stay open for hours at a stretch (the user's normal
 * workflow). A signal-subscription leak, a stray document-level event
 * listener, or an unbounded cache that nobody noticed will erode the app
 * gradually — the user's symptom is "browser tab is using 1.4 GB after
 * lunch" or "the worklist takes 8 s to re-render after a project switch".
 * Neither shows up in any existing unit / e2e test today.
 *
 * The closest existing prior art is `quit-confirm-dialog-growth.spec.ts`
 * (HS-8055), which catches xterm-pane width growth in the quit-confirm
 * preview. That test is targeted at a specific component bug; this spec
 * generalises the same monotonic-growth pattern to two of the highest-
 * traffic flows in the app:
 *
 *   1. **Ticket churn** — create + delete tickets in a loop. Exercises
 *      the `bindList`-virtualized ticket list (HS-8312), the kerf
 *      reactivity store layer (§61), the markdown-sync debouncer, and
 *      the long-poll fan-out. Pre-fix HS-8312 was the source of several
 *      "the worklist freezes when I have 500 tickets" reports — a leak
 *      here is the most user-felt category.
 *   2. **Search-filter churn** — type + clear the search input in a loop.
 *      Exercises the search-counts long-poll, the in-place row morph,
 *      and the include-archive / include-backlog grey-row paths (§40).
 *      A leaked signal subscription or per-keystroke fetch handle would
 *      compound here.
 *
 * Both tests use the Chrome DevTools Protocol (`Performance.getMetrics`
 * + `HeapProfiler.collectGarbage`) to take a stable heap reading before
 * and after the workload. CDP is the only way to get a JS-engine-level
 * GC trigger from Playwright; without it, `performance.memory` readings
 * drift by 10s of MB per sample and any threshold is meaningless.
 *
 * The thresholds are deliberately generous: the goal is to flag the
 * "leak that compounds" category (per-iteration retention) rather than
 * the "the app uses some memory while doing work" category (transient
 * peak). A real leak shows up as +N MB / +M nodes per cycle that never
 * comes back; a healthy app oscillates around a flat baseline.
 *
 * Failure modes the threshold tuning explicitly accepts:
 *  - One-off baseline growth on the first cycle (V8 warmup, lazy-loaded
 *    modules, font registration). We measure the delta BETWEEN cycles 2
 *    and 3, not between cycle 0 and 3.
 *  - GC stall jitter (+/- a few hundred KB).
 *  - Transient DOM additions from `bindList`'s virtualization sentinel
 *    rows.
 */
import type { CDPSession, Page } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

interface HeapSnapshot {
  /** JS heap used size in bytes, post-GC. The single most diagnostic
   *  metric for a leak — a healthy app's post-GC heap returns to a flat
   *  baseline across iterations. */
  jsHeapUsedBytes: number;
  /** Total live DOM node count. Catches detached-but-retained subtrees
   *  even when they don't show up as heap (e.g. a Map keyed by element
   *  ref that the GC can't collect because the Map itself is reachable). */
  jsHeapTotalBytes: number;
  /** Number of `Document` nodes the page reports — should always be 1
   *  on a single-tab session. Used as a smoke check. */
  documents: number;
  /** Live DOM node count (`Nodes` metric from CDP `Performance.metrics`).
   *  Tracks across all documents + adopted nodes. */
  nodes: number;
  /** Live event-listener count (`JSEventListeners` metric). A leak here
   *  manifests as growing per-cycle even when the DOM tree is the same
   *  size — common when a render path adds `addEventListener` without a
   *  matching `removeEventListener`. */
  listeners: number;
}

async function takeHeapSnapshot(cdp: CDPSession): Promise<HeapSnapshot> {
  // Force a major GC before the read so transient allocations from
  // the workload don't pollute the baseline. Without this, the
  // jsHeapUsedBytes reading drifts by 10s of MB per call and any
  // threshold is meaningless. Run twice — V8's incremental marker
  // sometimes needs two passes to settle.
  await cdp.send('HeapProfiler.collectGarbage');
  await cdp.send('HeapProfiler.collectGarbage');
  const { metrics } = await cdp.send('Performance.getMetrics');
  const byName = new Map(metrics.map(m => [m.name, m.value]));
  return {
    jsHeapUsedBytes: byName.get('JSHeapUsedSize') ?? 0,
    jsHeapTotalBytes: byName.get('JSHeapTotalSize') ?? 0,
    documents: byName.get('Documents') ?? 0,
    nodes: byName.get('Nodes') ?? 0,
    listeners: byName.get('JSEventListeners') ?? 0,
  };
}

/**
 * Run a workload N times, snapshotting the heap after each cycle.
 * Returns the per-cycle snapshots so the caller can compare cycle 2 vs
 * cycle N (skipping cycle 0 / 1 to avoid warmup noise).
 */
async function runCycles(
  cdp: CDPSession,
  cycles: number,
  workload: () => Promise<void>,
): Promise<HeapSnapshot[]> {
  const snapshots: HeapSnapshot[] = [];
  // Baseline before the first cycle — also lets the GC settle the
  // post-navigation transient allocations.
  snapshots.push(await takeHeapSnapshot(cdp));
  for (let i = 0; i < cycles; i += 1) {
    await workload();
    snapshots.push(await takeHeapSnapshot(cdp));
  }
  return snapshots;
}

/**
 * The core assertion. Skips the first warmup cycle (V8 JIT compilation,
 * lazy-loaded modules, font registration) and asserts that the delta
 * between cycle 2 and the final cycle is below the per-metric ceiling.
 *
 * Thresholds chosen to flag a real leak (which compounds at MB / hundreds
 * of nodes per cycle) without tripping on benign per-cycle jitter.
 */
function assertBoundedGrowth(label: string, snapshots: HeapSnapshot[]): void {
  expect(snapshots.length, `${label}: need at least 4 snapshots (baseline + 3 cycles)`).toBeGreaterThanOrEqual(4);
  // Skip the baseline (index 0) and the first cycle (index 1 — warmup).
  // Compare index 2 against the final index.
  const warm = snapshots[2];
  const last = snapshots[snapshots.length - 1];
  const heapDeltaBytes = last.jsHeapUsedBytes - warm.jsHeapUsedBytes;
  const heapDeltaMb = heapDeltaBytes / 1_048_576;
  const nodesDelta = last.nodes - warm.nodes;
  const listenersDelta = last.listeners - warm.listeners;
  // A leak that compounds at >~2 MB / cycle is the bug category we want
  // to catch. A healthy app oscillates within ~3 MB across cycles 2..N
  // even with the GC forced (V8 reserves blocks of pages and the post-GC
  // reading still reflects the high-water reservation). The 12 MB
  // ceiling assumes 4+ cycles of comparison — for 5 cycles that's an
  // allowed average ~2.4 MB / cycle; a real leak compounds well above
  // that bar.
  expect(heapDeltaMb, `${label}: JS heap delta ${heapDeltaMb.toFixed(2)} MB across cycles 2..${snapshots.length - 1}`).toBeLessThan(12);
  // Per-cycle node growth >100 indicates DOM retention. A healthy
  // bindList workload completes with the same node count it started.
  // The 500-node ceiling allows for one expected source of growth (the
  // ticket-number sequence increments the rendered `.ticket-number`
  // text, but the DOM count is invariant) plus a generous noise margin.
  expect(nodesDelta, `${label}: DOM node delta ${nodesDelta} across cycles 2..${snapshots.length - 1}`).toBeLessThan(500);
  // Per-cycle listener growth >50 indicates a missing
  // removeEventListener — typically a document-level capture handler
  // that survives a component unmount.
  expect(listenersDelta, `${label}: event-listener delta ${listenersDelta} across cycles 2..${snapshots.length - 1}`).toBeLessThan(150);
  // Document count is invariant — should not change across cycles.
  // Note that Chrome reports >1 in baseline contexts (the about:blank
  // shell + the live document), so we assert STABILITY across cycles
  // rather than an absolute count.
  expect(last.documents - warm.documents, `${label}: document count delta`).toBe(0);
}

test.describe('Memory / stability over time (HS-8570)', () => {
  test.beforeEach(async ({ page, errorCapture }) => {
    // The ticket-churn workload generates a high volume of brief 4xx
    // responses on the long-poll boundary as it tears down and rebuilds
    // the row set quickly; the long-poll path's transient aborts are
    // already covered by the global `/api/poll` allowlist but the
    // search-counts long-poll isn't, so allow the same shape per test.
    errorCapture.allowErrors([/\/api\/tickets\/search-counts/]);
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('ticket-list churn does not retain heap or DOM nodes across cycles', async ({ page, request }) => {
    // Use the API directly to create / delete tickets — driving the UI
    // for 50 create + 50 delete cycles per iteration would take minutes.
    // The API path still triggers the reactive ticket-list rebuild
    // (notify → long-poll wake → fetch → bindList reconcile), which is
    // the actual code under test.
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    const secret = projects[0]?.secret;
    expect(secret, 'need a project to test against').toBeDefined();
    const headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret ?? '' };

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');

    const TICKETS_PER_CYCLE = 30;
    async function churnCycle(): Promise<void> {
      // Create the batch.
      const createdIds: number[] = [];
      for (let i = 0; i < TICKETS_PER_CYCLE; i += 1) {
        const res = await request.post('/api/tickets', {
          headers,
          data: { title: `Churn ticket ${String(i)}`, defaults: { category: 'task' } },
        });
        if (res.ok()) {
          const t = await res.json() as { id: number };
          createdIds.push(t.id);
        }
      }
      // Let the long-poll wake + bindList rebuild settle.
      await expect(page.locator('.ticket-row[data-id]')).toHaveCount(TICKETS_PER_CYCLE, { timeout: 8000 });
      // Tear down.
      await request.post('/api/tickets/batch', { headers, data: { ids: createdIds, action: 'delete' } });
      await request.post('/api/trash/empty', { headers });
      await expect(page.locator('.ticket-row[data-id]')).toHaveCount(0, { timeout: 8000 });
    }

    // 6 cycles → 4 comparable deltas (skip baseline + first warmup
    // cycle). More cycles amplify a real per-cycle leak signal while
    // healthy code stays flat.
    const snapshots = await runCycles(cdp, 6, churnCycle);
    assertBoundedGrowth('ticket-churn', snapshots);
  });

  test('search-filter churn does not retain heap, DOM, or listeners', async ({ page, request }) => {
    // Seed a stable workload (the search filter has nothing to filter
    // against on an empty DB). 25 rows is enough to exercise the bindList
    // virtualizer's mount/unmount path without crossing the
    // page-size-100 threshold that triggers the Load More flow.
    const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
    const secret = projects[0]?.secret;
    expect(secret, 'need a project to test against').toBeDefined();
    const headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret ?? '' };
    for (let i = 0; i < 25; i += 1) {
      await request.post('/api/tickets', {
        headers,
        data: { title: `Search seed ${String(i)} alpha beta gamma`, defaults: { category: 'task' } },
      });
    }
    await expect(page.locator('.ticket-row[data-id]')).toHaveCount(25, { timeout: 10000 });

    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');

    // The search input is in the sidebar; the chrome ID is stable across
    // both list and column layouts because the reset fixture pins layout
    // to 'list'.
    const search = page.locator('#search-input');
    await expect(search).toBeVisible({ timeout: 5000 });

    async function searchCycle(): Promise<void> {
      // Type a query that matches all 25 rows so the include-archive /
      // include-backlog grey-row paths don't fire (they would change the
      // DOM count between iterations and inflate the threshold). The
      // "alpha beta gamma" suffix on each seeded title means a 5-char
      // query hits every row.
      await search.fill('alpha');
      await expect(page.locator('.ticket-row[data-id]')).toHaveCount(25, { timeout: 5000 });
      await search.fill('');
      await expect(page.locator('.ticket-row[data-id]')).toHaveCount(25, { timeout: 5000 });
    }

    // 8 cycles → 6 comparable deltas. The search-input workload is much
    // cheaper than ticket-churn so more cycles are feasible and a real
    // per-cycle signal compounds further.
    const snapshots = await runCycles(cdp, 8, searchCycle);
    assertBoundedGrowth('search-churn', snapshots);
  });
});

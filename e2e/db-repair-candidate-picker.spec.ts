/**
 * HS-9578 — browser coverage for the Database Repair candidate picker (§42,
 * shipped by HS-9575).
 *
 * The server half — enumeration, the not-a-cluster flag, size, and the four
 * `resolveCorruptCluster` path guards — is unit-tested in `src/db/repair.test.ts`.
 * The client half had none, which is where the behavior that MATTERS lives: on
 * 2026-08-04 the recovery marker named a 0-byte directory while the one holding
 * 432 tickets sat beside it, and the old flow used the marker silently. The
 * picker's job is to put that choice in front of the user and default it to the
 * candidate that actually yields the most tickets.
 *
 * Two tiers, split by what `pg_resetwal` is needed for:
 *
 *  - **Unconditional** — listing, the not-a-database marking, the default
 *    selection, and Cancel. These stub `/probe-corrupt-cluster` (and the
 *    availability probe, which gates the whole flow) so the counts are
 *    deterministic and the assertions run anywhere, including a CI container
 *    with no Postgres binaries.
 *  - **`pg_resetwal`-gated** — the real thing end to end: real clusters on disk,
 *    real probes, a real repair, and the resulting tarball's ticket count. Skips
 *    itself when the binary is absent (same shape as the GitHub-credentialed
 *    specs), because there is nothing to fall back to.
 *
 * Per CLAUDE.md §"Tauri-unsafe browser APIs", the confirm step goes through the
 * in-app `confirmDialog` overlay and this spec clicks its buttons — never
 * `page.on('dialog')`, which would mask the exact Tauri-silent-no-op class that
 * rule exists to catch.
 */
import type { APIRequestContext, Page } from '@playwright/test';
import { cpSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { join } from 'path';

import { expect, test } from './coverage-fixture.js';

/** Candidate directory names. The picker sorts newest-mtime first, so `NEWEST`
 *  is what a "just take the most recent one" implementation would pick — and it
 *  is deliberately NOT the one with the most tickets. */
const NEWEST = 'db-corrupt-2000000000000';
const RICHEST = 'db-corrupt-1000000000000';
const EMPTY_STUB = 'db-corrupt-1500000000000';
const NOT_A_CLUSTER = 'db-corrupt-1600000000000';

async function dataDirOf(request: APIRequestContext): Promise<string> {
  const projects = await (await request.get('/api/projects')).json() as { dataDir: string; secret: string }[];
  const dir = projects[0]?.dataDir ?? '';
  // Everything below seeds files INTO this directory, so a wrong or empty value
  // would silently write somewhere harmless and the assertions would be lies.
  if (dir === '') throw new Error('no project dataDir from /api/projects');
  return dir;
}

async function secretOf(request: APIRequestContext): Promise<string> {
  const projects = await (await request.get('/api/projects')).json() as { secret: string }[];
  return projects[0]?.secret ?? '';
}

/** Remove every `db-corrupt-*` left by a previous test in this worker — the
 *  server enumerates whatever is on disk, so a leftover would change the list
 *  under a later assertion. */
function clearCandidates(dataDir: string): void {
  for (const name of readdirSync(dataDir)) {
    if (name.startsWith('db-corrupt-')) rmSync(join(dataDir, name), { recursive: true, force: true });
  }
}

/** A directory that passes `looksLikeCluster` (PG_VERSION present) without being
 *  a real cluster. Enough for every assertion that does not probe. */
function seedFakeCluster(dataDir: string, name: string, mtimeSeconds: number): string {
  const dir = join(dataDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'PG_VERSION'), '15\n');
  writeFileSync(join(dir, 'filler'), 'x'.repeat(4096));
  utimesSync(dir, mtimeSeconds, mtimeSeconds);
  return dir;
}

/**
 * Click a control inside the Settings → Backups panel — with a REAL positional
 * click, deliberately.
 *
 * HS-9588: this used to `dispatchEvent('click')` to work around what looked like
 * a Playwright hit-testing quirk. It was not. `document.elementFromPoint` at the
 * buttons' centers returned `.settings-tab-panel`, and the reason was
 * `pointer-events: none` inherited from `[data-scope-complex].scope-locked` —
 * the docs/95 scope wrapper that Database Repair had been placed inside. Every
 * repair control was inert for a real user in the DEFAULT view, and a
 * `dispatchEvent` workaround would have hidden that forever.
 *
 * So these clicks must stay positional: they are the assertion.
 */
async function clickInPanel(page: Page, selector: string): Promise<void> {
  const el = page.locator(selector);
  await expect(el).toBeVisible({ timeout: 10000 });
  await expect(el).toBeEnabled();
  await el.click({ timeout: 10000 });
}

/** Open Settings and click "Run pg_resetwal…", which is what opens the picker. */
async function openPicker(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.draft-input')).toBeVisible({ timeout: 15000 });
  await page.locator('#settings-btn').click();
  await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 10000 });
  await page.locator('.settings-tab[data-tab="backups"]').click();
  await clickInPanel(page, '#db-repair-pg-resetwal-btn');
}

function optionTexts(page: Page): Promise<string[]> {
  return page.locator('#db-repair-corrupt-select option').allTextContents();
}

/**
 * HS-9588 — Database Repair must be REACHABLE, in the default view.
 *
 * It sat inside the docs/95 `[data-scope-complex]` wrapper, which sets
 * `pointer-events: none` when locked — and the default (Resolved) scope is a
 * locked one. So both repair buttons, and everything the flow renders into
 * `#db-repair-result`, were inert for a real user: clicks landed on the panel
 * behind them and nothing happened. Repair is an action, not a setting; there is
 * no local-vs-shared version of "recover my database".
 *
 * Asserted via `elementFromPoint` rather than a click, because a click that
 * silently does nothing is exactly the failure being guarded — the hit test is
 * the fact, and it is the one a passing `dispatchEvent` workaround concealed.
 */
test.describe('Database Repair is reachable in the default scope view (HS-9588)', () => {
  test('the repair controls receive pointer events', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 15000 });
    await page.locator('#settings-btn').click();
    await page.locator('.settings-tab[data-tab="backups"]').click();
    await expect(page.locator('#db-repair-pg-resetwal-btn')).toBeVisible({ timeout: 10000 });

    // The scope class is applied asynchronously once settings load. Wait for the
    // lock to be ACTIVE before asserting repair is unaffected by it — otherwise
    // this test can pass simply by measuring too early, which is how a re-nested
    // Repair section slipped past the first version of it.
    await expect(page.locator('.settings-tab-panel[data-panel="backups"] [data-scope-complex].scope-locked'))
      .toHaveCount(1, { timeout: 10000 });

    const hits = await page.evaluate(() => {
      const out: Record<string, { pointerEvents: string; hitIsSelf: boolean }> = {};
      for (const id of ['db-repair-find-working-btn', 'db-repair-pg-resetwal-btn']) {
        const el = document.getElementById(id);
        if (el === null) continue;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        out[id] = {
          pointerEvents: getComputedStyle(el).pointerEvents,
          hitIsSelf: hit === el || el.contains(hit),
        };
      }
      return out;
    });

    for (const id of ['db-repair-find-working-btn', 'db-repair-pg-resetwal-btn']) {
      const hit = hits[id] as { pointerEvents: string; hitIsSelf: boolean } | undefined;
      expect(hit, `${id} was not measured`).toBeDefined();
      expect(hit?.pointerEvents, `${id} pointer-events`).toBe('auto');
      expect(hit?.hitIsSelf, `${id} is the top element at its own center`).toBe(true);
    }
  });

  test('the snapshot-protection toggle stays scope-locked — it IS a setting', async ({ page }) => {
    // The other half of the fix: only Repair moved out of the wrapper. Getting
    // this wrong in the other direction would let a Local-scope edit silently
    // write a shared setting.
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 15000 });
    await page.locator('#settings-btn').click();
    await page.locator('.settings-tab[data-tab="backups"]').click();
    await expect(page.locator('#settings-snapshot-protection')).toBeAttached({ timeout: 10000 });
    const insideWrapper = await page.evaluate(() =>
      document.getElementById('settings-snapshot-protection')?.closest('[data-scope-complex]') !== null);
    expect(insideWrapper).toBe(true);
    const repairOutside = await page.evaluate(() =>
      document.getElementById('db-repair-pg-resetwal-btn')?.closest('[data-scope-complex]') === null);
    expect(repairOutside).toBe(true);
  });
});

test.describe('Database Repair candidate picker (HS-9578)', () => {
  test('lists every preserved directory, marks the ones that are not databases, and defaults to the most recoverable', async ({ page, request }) => {
    const dataDir = await dataDirOf(request);
    clearCandidates(dataDir);
    // Newest by mtime AND named by the recovery marker below — both of the
    // things the picker must NOT use to pick a default.
    const newest = seedFakeCluster(dataDir, NEWEST, 2_000_000_000);
    const richest = seedFakeCluster(dataDir, RICHEST, 1_000_000_000);
    // The 2026-08-04 trap: a directory that exists and looks plausible in a
    // file listing but holds nothing.
    mkdirSync(join(dataDir, EMPTY_STUB), { recursive: true });
    // A directory that is simply not a cluster.
    mkdirSync(join(dataDir, NOT_A_CLUSTER), { recursive: true });
    writeFileSync(join(dataDir, NOT_A_CLUSTER, 'notes.txt'), 'not a database');
    // Point the recovery marker at the WRONG one, so this test fails under the
    // pre-HS-9575 marker-driven behavior rather than passing by coincidence.
    writeFileSync(join(dataDir, '.db-recovery-marker.json'), JSON.stringify({
      kind: 'corrupt-open',
      corruptPath: newest,
      recoveredAt: new Date().toISOString(),
      errorMessage: 'seeded by HS-9578',
    }));

    // Stub only what needs a Postgres binary: the availability gate (which the
    // flow bails on first) and the per-candidate probe.
    await page.route('**/api/db/repair/pg-resetwal-availability**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        available: true, path: '/fake/pg_resetwal', platform: 'darwin',
        installInstructions: { description: 'x', command: 'x', url: 'https://example.invalid' },
      }),
    }));
    await page.route('**/api/db/repair/probe-corrupt-cluster**', async (route) => {
      // Matched on the directory NAME inside the raw body, not a parsed absolute
      // path: on macOS a temp dir is reachable as both `/var/...` and
      // `/private/var/...`, and the server's spelling need not be the one this
      // spec joined. The older directory is the rich one — so "newest" and "most
      // tickets" disagree, which is the whole point.
      const body = route.request().postData() ?? '';
      const count = body.includes(RICHEST) ? 432 : body.includes(NEWEST) ? 3 : null;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ recoverableTicketCount: count }),
      });
    });

    await openPicker(page);
    await expect(page.locator('#db-repair-corrupt-select')).toBeVisible({ timeout: 15000 });

    // 1. Every preserved directory is offered — including the ones that hold
    //    nothing, because "this one is empty" is information the user needs.
    await expect.poll(async () => (await optionTexts(page)).length, { timeout: 15000 }).toBe(4);
    const texts = (await optionTexts(page)).join('\n');
    expect(texts).toContain(NEWEST);
    expect(texts).toContain(RICHEST);
    expect(texts).toContain(EMPTY_STUB);
    expect(texts).toContain(NOT_A_CLUSTER);

    // 2. The non-databases say so, and cannot be chosen.
    const stubOption = page.locator(`#db-repair-corrupt-select option[value$="${EMPTY_STUB}"]`);
    await expect(stubOption).toHaveText(/not a database \(nothing to recover\)/);
    await expect(stubOption).toBeDisabled();
    await expect(page.locator(`#db-repair-corrupt-select option[value$="${NOT_A_CLUSTER}"]`)).toBeDisabled();

    // 3. Counts land per candidate as each probe resolves.
    await expect.poll(async () => (await optionTexts(page)).join('\n'), { timeout: 20000 })
      .toContain('432 tickets recoverable');

    // 4. The default is the one that yields the most — not the newest, and not
    //    the one the recovery marker names (both of which are `newest` here).
    await expect.poll(() => page.locator('#db-repair-corrupt-select').inputValue(), { timeout: 20000 })
      .toBe(richest);
  });

  test('Cancel closes the picker and runs nothing', async ({ page, request }) => {
    const dataDir = await dataDirOf(request);
    clearCandidates(dataDir);
    seedFakeCluster(dataDir, RICHEST, 1_000_000_000);

    await page.route('**/api/db/repair/pg-resetwal-availability**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        available: true, path: '/fake/pg_resetwal', platform: 'darwin',
        installInstructions: { description: 'x', command: 'x', url: 'https://example.invalid' },
      }),
    }));
    await page.route('**/api/db/repair/probe-corrupt-cluster**', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ recoverableTicketCount: 12 }),
    }));
    // A repair is destructive-adjacent (it writes a new tarball into the backup
    // tier), so Cancel must not reach it at all.
    let repairCalls = 0;
    await page.route('**/api/db/repair/run-pg-resetwal**', (route) => {
      repairCalls++;
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"must not be called"}' });
    });

    await openPicker(page);
    await expect(page.locator('#db-repair-corrupt-select')).toBeVisible({ timeout: 15000 });
    await clickInPanel(page, '#db-repair-corrupt-cancel');

    await expect(page.locator('#db-repair-corrupt-select')).toHaveCount(0);
    // No confirm overlay either — Cancel short-circuits before it.
    await expect(page.locator('.confirm-dialog-overlay')).toHaveCount(0);
    expect(repairCalls).toBe(0);
  });

  test('the confirm overlay can be dismissed without repairing', async ({ page, request }) => {
    // The in-app overlay is the Tauri-safe replacement for window.confirm, so
    // its cancel path is load-bearing: a no-op'd dialog in the desktop build
    // would otherwise look like "the button does nothing".
    const dataDir = await dataDirOf(request);
    clearCandidates(dataDir);
    seedFakeCluster(dataDir, RICHEST, 1_000_000_000);

    await page.route('**/api/db/repair/pg-resetwal-availability**', (route) => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        available: true, path: '/fake/pg_resetwal', platform: 'darwin',
        installInstructions: { description: 'x', command: 'x', url: 'https://example.invalid' },
      }),
    }));
    await page.route('**/api/db/repair/probe-corrupt-cluster**', (route) => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ recoverableTicketCount: 12 }),
    }));
    let repairCalls = 0;
    await page.route('**/api/db/repair/run-pg-resetwal**', (route) => {
      repairCalls++;
      return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"must not be called"}' });
    });

    await openPicker(page);
    await expect(page.locator('#db-repair-corrupt-select')).toBeVisible({ timeout: 15000 });
    await clickInPanel(page, '#db-repair-corrupt-go');

    const overlay = page.locator('.confirm-dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: 10000 });
    await expect(overlay).toContainText(RICHEST);
    await expect(overlay).toContainText('12 tickets recoverable');
    await overlay.getByRole('button', { name: 'Cancel' }).click();

    await expect(overlay).toHaveCount(0);
    expect(repairCalls).toBe(0);
  });
});

/**
 * The end-to-end test needs a machine where `pg_resetwal` can actually open a
 * PGLite cluster, which is more than "the binary exists": the major version has
 * to match the one PGLite writes (`candidatePgResetwalPaths` looks for 17
 * specifically, and an 18.x binary on PATH refuses a 17 cluster outright). So
 * the gate is the SERVER'S OWN probe against a real seeded candidate — if that
 * cannot recover a count, neither can the UI, and there is nothing meaningful
 * left to assert.
 */
async function canReallyProbe(request: APIRequestContext, headers: Record<string, string>, corruptPath: string): Promise<boolean> {
  const res = await request.post('/api/db/repair/probe-corrupt-cluster', { headers, data: { corruptPath } });
  if (!res.ok()) return false;
  const body = await res.json() as { recoverableTicketCount: number | null };
  return body.recoverableTicketCount !== null;
}

test.describe('Database Repair candidate picker — real repair (HS-9578)', () => {
  test('repairs the SELECTED candidate and the tarball carries its ticket count', async ({ page, request }) => {
    test.setTimeout(240_000);
    const dataDir = await dataDirOf(request);
    const headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': await secretOf(request) };
    clearCandidates(dataDir);

    // Snapshot the live cluster twice at different ticket counts. A preserved
    // `db-corrupt-*` directory IS a copy of a live cluster, so this is the real
    // artifact rather than a fixture — and `probeCorruptCluster` copies it again
    // and runs `pg_resetwal -f` before opening, which is what makes a copy taken
    // from a running server viable.
    const countTickets = async (): Promise<number> => {
      const res = await request.get('/api/tickets', { headers });
      const rows = await res.json() as { status: string }[];
      return rows.filter((t) => t.status !== 'deleted').length;
    };

    // The FIRST copy is the poorer one, and gets the NEWEST mtime — so a
    // "newest wins" default would choose it and this test would fail.
    await request.post('/api/backups/now', { headers });
    const leanCount = await countTickets();
    const leanDir = join(dataDir, NEWEST);
    cpSync(join(dataDir, 'db'), leanDir, { recursive: true });
    rmSync(join(leanDir, 'postmaster.pid'), { force: true });
    utimesSync(leanDir, 2_000_000_000, 2_000_000_000);

    for (let i = 0; i < 5; i++) {
      await request.post('/api/tickets', { headers, data: { title: `HS-9578 richer ${String(i)}` } });
    }
    await request.post('/api/backups/now', { headers });
    const richCount = await countTickets();
    expect(richCount).toBe(leanCount + 5);
    const richDir = join(dataDir, RICHEST);
    cpSync(join(dataDir, 'db'), richDir, { recursive: true });
    rmSync(join(richDir, 'postmaster.pid'), { force: true });
    utimesSync(richDir, 1_000_000_000, 1_000_000_000);

    // Gate: can this machine's pg_resetwal actually open a PGLite cluster?
    test.skip(
      !await canReallyProbe(request, headers, richDir),
      'pg_resetwal on this machine cannot recover a PGLite cluster (missing, or a major-version mismatch)',
    );

    await openPicker(page);
    await expect(page.locator('#db-repair-corrupt-select')).toBeVisible({ timeout: 20000 });

    // Both probes are real: copy → pg_resetwal -f → open → COUNT, one at a time.
    await expect.poll(async () => (await optionTexts(page)).join('\n'), { timeout: 180_000 })
      .toContain(`${String(richCount)} tickets recoverable`);
    await expect.poll(async () => (await optionTexts(page)).join('\n'), { timeout: 180_000 })
      .toContain(`${String(leanCount)} tickets recoverable`);

    // The default landed on the richer, OLDER directory.
    await expect.poll(() => page.locator('#db-repair-corrupt-select').inputValue(), { timeout: 30_000 })
      .toBe(richDir);

    await clickInPanel(page, '#db-repair-corrupt-go');
    const overlay = page.locator('.confirm-dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: 10000 });
    await expect(overlay).toContainText(RICHEST);
    await overlay.getByRole('button', { name: 'Run pg_resetwal' }).click();

    // The repair ran against the SELECTED path, so the tarball it produced holds
    // that candidate's rows — not the lean one's.
    await expect(page.locator('#db-repair-result')).toContainText(
      `${String(richCount)} tickets`, { timeout: 180_000 },
    );
    await expect(page.locator('#db-repair-result')).toContainText('Repaired tarball created');
  });
});

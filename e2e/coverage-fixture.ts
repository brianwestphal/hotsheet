import { test as base } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

// HS-8367 — suppress the §50 / HS-7962 upgrade-nudge overlay in every
// e2e test by default. The nudge is a near-full-viewport modal that
// appears on app boot for npm-launched (non-Tauri) users, throttled via
// `localStorage['hotsheet_upgrade_nudge_last_shown']`. Without
// suppression it covers the `.draft-input`, `.ticket-row`, and detail
// panel — any test that drives the create-ticket / row-click flow on a
// fresh Playwright context (every test gets a fresh localStorage) hits
// the overlay and fails to interact with the underlying chrome. Pre-fix
// half the `tickets.spec.ts` suite (`click a ticket row`, `edit ticket
// title`, `toggle the up-next star`, etc.) was failing intermittently
// for this exact reason; the test that initially worked was the FIRST
// one after a context creation that happened to not trigger the boot
// nudge path. `Number.MAX_SAFE_INTEGER` is the "don't show again"
// sentinel per HS-7962's design — writing it pre-page-load suppresses
// the boot-time nudge without touching production code. Tests that
// specifically want to exercise the nudge UI can override by clearing
// the key in their own `beforeEach`.
const SUPPRESS_UPGRADE_NUDGE_SCRIPT = `
  try {
    window.localStorage.setItem('hotsheet_upgrade_nudge_last_shown', String(Number.MAX_SAFE_INTEGER));
  } catch { /* private mode etc. */ }
`;

// HS-8367 follow-up — server-persisted settings leak across specs because
// the Playwright `webServer` runs ONE Hot Sheet instance for the whole
// 375-test suite. If `columns.spec.ts` or `column-arrow-nav.spec.ts`
// leaves `layout: 'columns'` saved (the layout button click PATCHes
// /api/settings) and the next spec does `page.goto('/')` expecting list
// view, every `.ticket-row[data-id] .ticket-title-input[value="..."]`
// locator misses because column-view cards render `.column-card-title`
// instead. Same shape for `drawer_open: 'true'` — a terminal spec that
// opens the drawer can hide ticket rows behind the drawer for any
// subsequent spec that doesn't explicitly reset it. Reset both keys per-
// test so specs that need a non-default value PATCH it inside their own
// `beforeEach` / test body AFTER this fixture has run.
const RESET_SETTINGS_HEADERS = { 'Content-Type': 'application/json' };
async function resetCrossSpecSettings(request: import('@playwright/test').APIRequestContext): Promise<void> {
  let projects: { secret?: string }[] = [];
  try {
    projects = await (await request.get('/api/projects')).json() as { secret?: string }[];
  } catch { return; }
  const secret = projects[0]?.secret;
  if (secret === undefined || secret === '') return;
  const authHeaders = { ...RESET_SETTINGS_HEADERS, 'X-Hotsheet-Secret': secret };
  await Promise.allSettled([
    // `sortBy` + `sortDir` are server-persisted alongside layout/view, so a
    // prior spec that flipped to "Oldest First" parks newly-created tickets
    // off-viewport (with 350+ pre-existing rows accumulated across the
    // sweep) and `bindListVirtualized` doesn't mount them. The locator
    // resolves to nothing for the just-created ticket and the test times
    // out at the `.click()` call. Reset to the implicit defaults.
    // Settings stored as strings via /api/settings — booleans are read back
    // via `settings.detail_visible !== 'false'` in `settingsLoader.tsx`.
    // `detail_visible: 'false'` leaks from ui-gaps.spec.ts:144 (the
    // "toggle off" test) into every spec that opens the detail panel
    // (detail.spec.ts, ticket-lifecycle.spec.ts, unread-indicators.spec.ts).
    // `detail_position: 'bottom'` leaks from ui-gaps.spec.ts:115.
    request.patch('/api/settings', { headers: authHeaders, data: { layout: 'list', view: 'all', sortBy: 'created', sortDir: 'desc', detail_visible: 'true', detail_position: 'side' } }),
    // HS-8419 — `drawer_expanded: 'true'` leaks from drawer-expand.spec.ts:78
    // ("expanded state persists across reload"). When set, `.app.drawer-expanded`
    // applies `display: none` to `.app-body`, hiding the draft input + ticket
    // list for any later spec that does `page.goto('/')`.
    request.patch('/api/file-settings', { headers: authHeaders, data: { drawer_open: 'false', drawer_active_tab: 'commands-log', drawer_expanded: 'false' } }),
    // HS-8419 — `dashboard.layoutMode` moved from per-project file-settings
    // to global config in HS-8290. `terminal-dashboard-flow-layout.spec.ts`
    // test 42 toggles flow mode and persists via the UI (which writes to
    // global-config), but its `afterEach` only resets via the dead
    // `dashboard_layout_mode` file-settings key. Result: flow mode leaks
    // across to terminal-dashboard.spec.ts:92 / :114, where the dashboard
    // renders `.terminal-dashboard-grid-flow` instead of the per-project
    // `.terminal-dashboard-section`s the tests expect to find. The
    // /global-config endpoint is cross-project; the mutation-without-Origin
    // CSRF gate in `server.ts` rejects with 403 unless we send the
    // project's `X-Hotsheet-Secret`, so reuse `authHeaders` even though the
    // request is logically project-agnostic.
    request.patch('/api/global-config', { headers: authHeaders, data: { dashboard: { layoutMode: 'sectioned' } } }),
  ]);

  // Wipe accumulated tickets so the per-test workload starts from an empty
  // DB. The single Playwright `webServer` persists ticket rows across all
  // 375 tests in a sweep, and once the count crosses
  // `bindListVirtualized`'s 100-row threshold, the viewport math drops
  // tickets that aren't in the rendered window — a `[value="..."]`
  // locator for a row past the window resolves to nothing and the test
  // times out. Specs that need a non-empty DB POST tickets in their own
  // `beforeAll` / test body AFTER this fixture runs.
  try {
    const allRes = await request.get('/api/tickets?status=active', { headers: authHeaders });
    if (allRes.ok()) {
      const active = await allRes.json() as { id: number }[];
      const trashRes = await request.get('/api/tickets?status=deleted', { headers: authHeaders });
      const trashed = trashRes.ok() ? await trashRes.json() as { id: number }[] : [];
      const ids = [...active.map(t => t.id), ...trashed.map(t => t.id)];
      if (ids.length > 0) {
        // batch action 'delete' moves to trash; then empty-trash hard-deletes.
        await request.post('/api/tickets/batch', { headers: authHeaders, data: { ids, action: 'delete' } });
        await request.post('/api/trash/empty', { headers: authHeaders });
      }
    }
  } catch { /* swallow — best-effort */ }

  // HS-8419 — kill every alive PTY + destroy every dynamic-terminal config
  // so specs like `quit-confirm-dialog-growth.spec.ts` (which counts
  // dialog rows against `/api/projects/quit-summary` =
  // `listAliveTerminalsAcrossProjects`) start from zero alive terminals.
  // Configured terminals from earlier specs' file-settings PATCHes have
  // their PTYs survive across specs because `writeFileSettings` only
  // updates the config; the PTY registry has its own lifecycle. The
  // quit-confirm test's `beforeEach` only destroys *dynamic* terminals
  // (the `for (const d of list.dynamic)` loop) — configured-but-still-alive
  // PTYs from terminal.spec.ts / terminal-appearance.spec.ts /
  // terminal-search.spec.ts persist, leak into `quit-summary`, and inflate
  // the row count from the expected 3 to 6+.
  try {
    const listRes = await request.get('/api/terminal/list', { headers: authHeaders });
    if (listRes.ok()) {
      const list = await listRes.json() as {
        configured?: { id: string; state?: string }[];
        dynamic?: { id: string }[];
      };
      const killTargets = [
        ...(list.configured ?? []).filter(t => t.state === 'alive').map(t => t.id),
      ];
      for (const id of killTargets) {
        await request.post('/api/terminal/kill', { headers: authHeaders, data: { terminalId: id } }).catch(() => {});
      }
      for (const d of (list.dynamic ?? [])) {
        await request.post('/api/terminal/destroy', { headers: authHeaders, data: { terminalId: d.id } }).catch(() => {});
      }
    }
  } catch { /* swallow — best-effort */ }
}

// Collect browser JS coverage and write V8-format JSON for c8 to process.
// Rewrites the URL from HTTP to the local file path so c8 can find the source map.
export const test = base.extend<{ autoJSCoverage: void; suppressUpgradeNudge: void; resetSettings: void }>({
  resetSettings: [async ({ request }, use) => {
    await resetCrossSpecSettings(request);
    await use();
  }, { auto: true }],
  suppressUpgradeNudge: [async ({ page }, use) => {
    await page.addInitScript(SUPPRESS_UPGRADE_NUDGE_SCRIPT);
    await use();
  }, { auto: true }],
  autoJSCoverage: [async ({ page }, use) => {
    const coverageDir = process.env.BROWSER_V8_COVERAGE;
    if (!coverageDir) {
      await use();
      return;
    }
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use();
    const coverage = await page.coverage.stopJSCoverage();
    // The app bundle is served as /static/app.js but lives at dist/client/app.global.js
    const appEntries = coverage.filter(e => e.url.includes('/static/app.js'));
    if (appEntries.length > 0) {
      mkdirSync(coverageDir, { recursive: true });
      // Rewrite URL to local file path so c8 can resolve the source map
      const localPath = resolve('dist/client/app.global.js');
      const rewritten = appEntries.map(entry => ({
        ...entry,
        url: `file://${localPath}`,
      }));
      const v8Data = { result: rewritten };
      const filename = `browser-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
      writeFileSync(join(coverageDir, filename), JSON.stringify(v8Data));
    }
  }, { auto: true }],
});

export { expect } from '@playwright/test';

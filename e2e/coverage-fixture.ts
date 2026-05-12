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

// Collect browser JS coverage and write V8-format JSON for c8 to process.
// Rewrites the URL from HTTP to the local file path so c8 can find the source map.
export const test = base.extend<{ autoJSCoverage: void; suppressUpgradeNudge: void }>({
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

import { test as base } from '@playwright/test';
import { writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';

// Collect browser JS coverage and write V8-format JSON for c8 to process.
// Rewrites the URL from HTTP to the local file path so c8 can find the source map.
export const test = base.extend<{ autoJSCoverage: void }>({
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

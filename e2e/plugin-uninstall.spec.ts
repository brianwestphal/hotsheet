/**
 * HS-5065: plugin uninstall flow + bundled dismissal persistence.
 *
 * User expectation: "if I uninstall a bundled plugin, it stays gone — it
 * doesn't reinstall itself unless I explicitly reinstall."
 *
 * IMPORTANT: this test uninstalls github-issues, then reinstalls it. It must
 * run AFTER other plugin tests and restore the plugin in afterAll so the
 * fixture isn't poisoned for other test files. Playwright runs spec files
 * in parallel by default, but these tests are serialized within this file.
 */
import { expect, test } from './coverage-fixture.js';

const PLUGINS_ENABLED = process.env.PLUGINS_ENABLED === 'true';

test.describe('Plugin uninstall + bundled dismissal (HS-5065)', () => {
  test.skip(!PLUGINS_ENABLED, 'PLUGINS_ENABLED not set');
  test.setTimeout(60_000);
  // Run tests serially — uninstall must happen before reinstall
  test.describe.configure({ mode: 'serial' });

  let headers: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    const secret = projects[0]?.secret ?? '';
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret };
  });

  // Always reinstall after the suite to restore the fixture for other tests
  test.afterAll(async ({ request }) => {
    try {
      await request.post('/api/plugins/bundled/github-issues/install', { headers });
      await request.post('/api/plugins/github-issues/enable', { headers });
    } catch { /* best effort */ }
  });

  test('uninstall via API removes plugin from list and dismisses it', async ({ request }) => {
    // Verify plugin exists before uninstall
    const beforeRes = await request.get('/api/plugins', { headers });
    const before = await beforeRes.json() as { id: string }[];
    expect(before.some(p => p.id === 'github-issues')).toBe(true);

    // Uninstall
    const uninstallRes = await request.post('/api/plugins/github-issues/uninstall', { headers });
    expect(uninstallRes.ok()).toBe(true);

    // Plugin should no longer appear in the plugins list
    const afterRes = await request.get('/api/plugins', { headers });
    const after = await afterRes.json() as { id: string }[];
    expect(after.some(p => p.id === 'github-issues')).toBe(false);

    // Bundled endpoint should show installed=false, dismissed=true
    // (The e2e server uses an isolated HOME, so we verify via API not filesystem)
    const bundledRes = await request.get('/api/plugins/bundled', { headers });
    const bundled = await bundledRes.json() as { manifest: { id: string }; installed: boolean; dismissed: boolean }[];
    const gh = bundled.find(b => b.manifest.id === 'github-issues');
    expect(gh).toBeTruthy();
    expect(gh!.installed).toBe(false);
    expect(gh!.dismissed).toBe(true);
  });

  test('reinstall via bundled install restores the plugin', async ({ request }) => {
    // Install the bundled plugin
    const installRes = await request.post('/api/plugins/bundled/github-issues/install', { headers });
    expect(installRes.ok()).toBe(true);

    // Plugin should reappear in the plugins list
    const afterRes = await request.get('/api/plugins', { headers });
    const after = await afterRes.json() as { id: string }[];
    expect(after.some(p => p.id === 'github-issues')).toBe(true);

    // Bundled endpoint should show installed=true, dismissed=false
    const bundledRes = await request.get('/api/plugins/bundled', { headers });
    const bundled = await bundledRes.json() as { manifest: { id: string }; installed: boolean; dismissed: boolean }[];
    const gh = bundled.find(b => b.manifest.id === 'github-issues');
    expect(gh!.installed).toBe(true);
    expect(gh!.dismissed).toBe(false);
  });
});

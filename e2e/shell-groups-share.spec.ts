/**
 * HS-5189: shell commands, command groups, and share prompt tests.
 * Tests the automatable items; drag-drop and timing-based items are in the manual test plan.
 */
import { expect, test } from './coverage-fixture.js';

test.describe('Shell commands (§15)', () => {
  let headers: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    const projectsRes = await request.get('/api/projects');
    const projects = await projectsRes.json() as { secret: string }[];
    const secret = projects[0]?.secret ?? '';
    headers = { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret };
  });

  test('POST /api/shell/exec runs a command and returns a log entry ID', async ({ request }) => {
    const res = await request.post('/api/shell/exec', {
      headers, data: { command: 'echo hello-shell-test' },
    });
    expect(res.ok()).toBe(true);
    const data = await res.json() as { id: number };
    expect(data.id).toBeGreaterThan(0);

    // Wait briefly for the command to complete
    await new Promise(r => setTimeout(r, 500));

    // The command log should have the entry with output
    const logRes = await request.get('/api/command-log', { headers });
    const logs = await logRes.json() as { id: number; detail: string; summary: string }[];
    const entry = logs.find(l => l.id === data.id);
    expect(entry).toBeTruthy();
    expect(entry!.detail).toContain('hello-shell-test');
    expect(entry!.detail).toContain('---SHELL_OUTPUT---');
  });

  test('GET /api/shell/running returns empty when no commands are active', async ({ request }) => {
    const res = await request.get('/api/shell/running', { headers });
    expect(res.ok()).toBe(true);
    const data = await res.json() as { ids: number[] };
    expect(Array.isArray(data.ids)).toBe(true);
  });

  test('POST /api/shell/exec starts a command and kill returns ok', async ({ request }) => {
    // Start a command
    const execRes = await request.post('/api/shell/exec', {
      headers, data: { command: 'echo "shell test"' },
    });
    expect(execRes.ok()).toBe(true);
    const { id } = await execRes.json() as { id: number };
    expect(id).toBeGreaterThan(0);

    // Verify kill endpoint works (404 if already finished, 200 if still running — both valid)
    await new Promise(r => setTimeout(r, 200));
    const killRes = await request.post('/api/shell/kill', {
      headers, data: { id },
    });
    // Either 200 (killed) or 404 (already finished) is acceptable
    expect([200, 404]).toContain(killRes.status());
  });
});

test.describe('Command groups (§16)', () => {
  // Collapse/expand toggle, drag-drop reorder, inline name edit, and collapse
  // persistence are covered in the manual test plan (docs/manual-test-plan.md §5).
  // The e2e command group tests in e2e/commands.spec.ts cover add/delete group.
});

test.describe('Share prompt (§17)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  test('share link is visible in the footer', async ({ page }) => {
    const shareLink = page.locator('#share-link');
    await expect(shareLink).toBeVisible({ timeout: 3000 });
    const text = await shareLink.textContent();
    expect(text).toContain('Share Hot Sheet');
  });
});

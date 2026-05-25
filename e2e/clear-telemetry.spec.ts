import type { APIRequestContext, Page } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

/**
 * HS-8608 / §74 — E2E for the Settings → Telemetry → Retention "Clear
 * telemetry data" button (feature HS-8606). Exercises the real round-trip:
 * seed otel rows via the OTLP receiver, click the button, click the in-app
 * confirm overlay's real button (NOT `page.on('dialog')` — the confirm is the
 * Tauri-safe `confirmDialog` overlay), and assert the status line + that the
 * project's telemetry is actually gone server-side. Plus the cancel path.
 */

/** Minimal valid OTLP/JSON metrics payload tagged with the project secret so
 *  the receiver's `hotsheet_project` gate accepts it. One `cost.usage` point
 *  with a `session.id` so the rollup's prompt-count proxy is also non-zero. */
function metricsPayload(secret: string): unknown {
  return {
    resourceMetrics: [
      {
        resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: secret } }] },
        scopeMetrics: [
          {
            metrics: [
              {
                name: 'claude_code.cost.usage',
                sum: {
                  dataPoints: [
                    {
                      asDouble: 0.42,
                      timeUnixNano: String(Date.now() * 1_000_000),
                      attributes: [{ key: 'session.id', value: { stringValue: 'e2e-session' } }],
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  };
}

test.describe('Clear telemetry data (HS-8606 / §74)', () => {
  let secret: string;

  test.beforeEach(async ({ page, request }) => {
    const projects = await request.get('/api/projects').then((r) => r.json()) as { secret: string }[];
    secret = projects[0]?.secret ?? '';
    expect(secret).not.toBe('');
    // Enable telemetry so the panel reads as a coherent, real configuration.
    await request.patch('/api/file-settings', {
      headers: { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret },
      data: { telemetry_enabled: true },
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  async function seedTelemetry(request: APIRequestContext): Promise<void> {
    const res = await request.post('/v1/metrics', {
      headers: { 'Content-Type': 'application/json' },
      data: metricsPayload(secret),
    });
    expect(res.status()).toBe(200);
  }

  async function allTimeCost(request: APIRequestContext): Promise<number> {
    const payload = await request
      .get(`/api/telemetry/project-rollup?project=${encodeURIComponent(secret)}`)
      .then((r) => r.json()) as { windowTotals: { allTime: { cost: number } } };
    return payload.windowTotals.allTime.cost;
  }

  async function openTelemetryRetention(page: Page): Promise<void> {
    await page.locator('#settings-btn').click();
    await expect(page.locator('#settings-overlay')).toBeVisible({ timeout: 3000 });
    await page.locator('.settings-tab[data-tab="telemetry"]').click();
    await expect(page.locator('.settings-tab-panel[data-panel="telemetry"]')).toHaveClass(/active/);
    await expect(page.locator('#settings-telemetry-clear-btn')).toBeVisible({ timeout: 3000 });
  }

  test('clears seeded telemetry and reports the count, leaving the project at zero', async ({ page, request }) => {
    await seedTelemetry(request);
    expect(await allTimeCost(request)).toBeGreaterThan(0);

    await openTelemetryRetention(page);

    // Click the button → in-app confirm overlay → click its REAL confirm button.
    await page.locator('#settings-telemetry-clear-btn').click();
    const overlay = page.locator('.confirm-dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: 3000 });
    await overlay.locator('.confirm-dialog-confirm').click();

    // Status line reflects a successful clear.
    await expect(page.locator('#settings-telemetry-clear-status'))
      .toHaveText(/Cleared \d+ telemetry rows?\./, { timeout: 5000 });

    // Server-side: the project's telemetry is gone.
    expect(await allTimeCost(request)).toBe(0);
  });

  test('cancelling the confirm leaves telemetry intact', async ({ page, request }) => {
    await seedTelemetry(request);

    await openTelemetryRetention(page);

    await page.locator('#settings-telemetry-clear-btn').click();
    const overlay = page.locator('.confirm-dialog-overlay');
    await expect(overlay).toBeVisible({ timeout: 3000 });
    await overlay.locator('.confirm-dialog-cancel').click();
    await expect(overlay).toBeHidden();

    // No status written, and the data survives.
    await expect(page.locator('#settings-telemetry-clear-status')).toHaveText('');
    expect(await allTimeCost(request)).toBeGreaterThan(0);
  });
});

import type { APIRequestContext } from '@playwright/test';

import { expect, test } from './coverage-fixture.js';

/**
 * HS-8710 — the per-prompt timeline drilldown modal (§67.10.3,
 * `src/client/promptDrilldown.tsx`) was not scrollable: the dialog
 * (`.telemetry-drilldown-dialog` / `.reader-mode-dialog`) is a fixed-height
 * 90vh flex column with `overflow: hidden`, but the body
 * (`.telemetry-drilldown-content`) had NO scroll-bounding CSS, so a long
 * timeline (the common case — dozens of events) overflowed and was clipped
 * with no way to reach the lower rows.
 *
 * This is a layout/scroll bug, so a happy-dom unit test can't catch it (no CSS
 * layout engine). The regression guard is this Chromium E2E: seed many events
 * under one prompt id, open the real drilldown through the analytics dashboard
 * recent-prompts list, and assert the content area actually scrolls
 * (`scrollHeight > clientHeight`) with an `overflow-y` that permits it.
 */

/** A single OTLP/JSON log record tagged for the timeline. `event.name` drives
 *  the row label + the recent-prompts `user_prompt` match; `prompt.id` ties
 *  every record to one timeline. */
function logRecord(eventName: string, promptId: string, index: number): unknown {
  return {
    timeUnixNano: String((Date.now() + index) * 1_000_000),
    attributes: [
      { key: 'event.name', value: { stringValue: eventName } },
      { key: 'prompt.id', value: { stringValue: promptId } },
      { key: 'session.id', value: { stringValue: 'e2e-drilldown-session' } },
      { key: 'model', value: { stringValue: 'claude-opus-4-8' } },
    ],
  };
}

/** One `user_prompt` (so the prompt surfaces in the recent-prompts list) plus
 *  `EVENT_COUNT - 1` `tool_result` rows so the timeline is long enough to
 *  overflow the 90vh dialog. */
const EVENT_COUNT = 60;
function logsPayload(secret: string, promptId: string): unknown {
  const records: unknown[] = [logRecord('claude_code.user_prompt', promptId, 0)];
  for (let i = 1; i < EVENT_COUNT; i++) {
    records.push(logRecord('claude_code.tool_result', promptId, i));
  }
  return {
    resourceLogs: [
      {
        resource: { attributes: [{ key: 'hotsheet_project', value: { stringValue: secret } }] },
        scopeLogs: [{ logRecords: records }],
      },
    ],
  };
}

test.describe('Prompt timeline drilldown is scrollable (HS-8710)', () => {
  let secret: string;
  const promptId = 'ffba231b-9cb0-47b3-89a7-f388abc01cfe';

  test.beforeEach(async ({ page, request }) => {
    const projects = await request.get('/api/projects').then((r) => r.json()) as { secret: string }[];
    secret = projects[0]?.secret ?? '';
    expect(secret).not.toBe('');
    await request.patch('/api/file-settings', {
      headers: { 'Content-Type': 'application/json', 'X-Hotsheet-Secret': secret },
      data: { telemetry_enabled: true },
    });
    await page.goto('/');
    await expect(page.locator('.draft-input')).toBeVisible({ timeout: 10000 });
  });

  async function seedTimeline(request: APIRequestContext): Promise<void> {
    const res = await request.post('/v1/logs', {
      headers: { 'Content-Type': 'application/json' },
      data: logsPayload(secret, promptId),
    });
    expect(res.status()).toBe(200);
    // Sanity-check the timeline really has the rows we seeded before we drive
    // the UI — keeps a flake in the UI path from masking an ingestion failure.
    const timeline = await request
      .get(`/api/telemetry/prompt/${encodeURIComponent(promptId)}`)
      .then((r) => r.json()) as { entries: unknown[] };
    expect(timeline.entries.length).toBe(EVENT_COUNT);
  }

  test('long timeline overflows but the content area scrolls', async ({ page, request }) => {
    await seedTimeline(request);

    // Open the analytics dashboard (sidebar widget → dashboard mode), then the
    // telemetry section's recent-prompts list.
    await page.locator('#sidebar-dashboard-widget').click();
    const promptRow = page.locator('.telemetry-recent-prompts .telemetry-recent-prompt').first();
    await expect(promptRow).toBeVisible({ timeout: 10000 });
    await promptRow.click();

    // The drilldown overlay opens and the flat event list paints all the rows.
    const overlay = page.locator('.telemetry-drilldown-overlay');
    await expect(overlay).toBeVisible({ timeout: 5000 });
    await expect(page.locator('.telemetry-timeline-row')).toHaveCount(EVENT_COUNT, { timeout: 5000 });

    // The content body must own the scroll: its content is taller than its box
    // AND its computed overflow-y permits scrolling. Pre-fix the missing CSS
    // left `overflow-y: visible` and the rows were clipped by the dialog.
    const content = page.locator('.telemetry-drilldown-content');
    const metrics = await content.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    }));
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    expect(['auto', 'scroll']).toContain(metrics.overflowY);

    // And it actually scrolls when driven — the decisive end-to-end assertion.
    await content.evaluate((el) => { el.scrollTop = el.scrollHeight; });
    const scrolled = await content.evaluate((el) => el.scrollTop);
    expect(scrolled).toBeGreaterThan(0);
  });
});

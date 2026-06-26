// HS-9100 — the demo seeder closes the bottom drawer by default (it defaults
// OPEN on first use, HS-8845, which left an empty Commands Log drawer wasting
// ~a third of the viewport in most demo screenshots/SVGs). The embedded-terminal
// showcase (scenario 11) still re-opens it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { seedDemoData } from './demo.js';
import { readFileSettings } from './file-settings.js';
import { cleanupTestDb, setupTestDb } from './test-helpers.js';

describe('seedDemoData — drawer state (HS-9100)', () => {
  let dir: string;
  beforeEach(async () => { dir = await setupTestDb(); });
  afterEach(async () => { await cleanupTestDb(dir); });

  it('closes the bottom drawer for a non-terminal scenario (no empty log drawer)', async () => {
    await seedDemoData(1);
    expect(readFileSettings(dir).drawer_open).toBe('false');
  });

  it('keeps the drawer OPEN for the embedded-terminal showcase (scenario 11)', async () => {
    await seedDemoData(11);
    expect(readFileSettings(dir).drawer_open).toBe('true');
  });
});

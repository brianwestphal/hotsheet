import { mkdirSync, rmSync } from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * HS-8492 — pin the default-true behavior of `migrateGlobalConfig`
 * for new installs. Pre-fix the migration's fallback when neither
 * the global config nor the legacy per-project DB had an explicit
 * `channel_enabled` value was `false` (channel off by default).
 * Post-fix the fallback is `true`. Existing users with a persisted
 * value (in either the global config OR the legacy DB) are NOT
 * affected — those branches still resolve to whatever the user
 * had set.
 */

const tempHome = join(os.tmpdir(), `hs-cli-migrate-test-${String(Date.now())}`);

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tempHome };
});

const settingsMock: { channel_enabled?: string } = {};

vi.mock('./db/queries.js', () => ({
  getSettings: async () => Promise.resolve({ ...settingsMock }),
}));

const { migrateGlobalConfig } = await import('./cli.js');
const { readGlobalConfig, writeGlobalConfig } = await import('./global-config.js');

beforeEach(() => {
  try { rmSync(join(tempHome, '.hotsheet'), { recursive: true, force: true }); } catch { /* ignore */ }
  mkdirSync(join(tempHome, '.hotsheet'), { recursive: true });
  // Reset the legacy-DB mock for each case.
  delete settingsMock.channel_enabled;
});

afterAll(() => {
  try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('migrateGlobalConfig — channelEnabled default for new installs (HS-8492)', () => {
  it('defaults channelEnabled to TRUE when neither global config nor legacy DB has a value', async () => {
    // New install: no global `channelEnabled`, no legacy `channel_enabled` in DB.
    await migrateGlobalConfig();
    expect(readGlobalConfig().channelEnabled).toBe(true);
  });

  it('preserves legacy channel_enabled === "true" from the per-project DB', async () => {
    settingsMock.channel_enabled = 'true';
    await migrateGlobalConfig();
    expect(readGlobalConfig().channelEnabled).toBe(true);
  });

  it('preserves legacy channel_enabled === "false" from the per-project DB (does NOT flip to true)', async () => {
    // Critical regression guard: a user who had explicitly disabled
    // the channel pre-HS-8492 must keep their `false` value through
    // the migration. Only the genuinely-no-value case gets the new
    // default.
    settingsMock.channel_enabled = 'false';
    await migrateGlobalConfig();
    expect(readGlobalConfig().channelEnabled).toBe(false);
  });

  it('is a no-op when channelEnabled is already set in the global config', async () => {
    // Persist a pre-existing value (could be true OR false — what matters is the migration leaves it alone).
    writeGlobalConfig({ channelEnabled: false });
    settingsMock.channel_enabled = 'true'; // would otherwise flip — but the migration shouldn't even look at this branch.
    await migrateGlobalConfig();
    expect(readGlobalConfig().channelEnabled).toBe(false);
  });
});

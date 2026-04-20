import { mkdirSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { tmpdir } = os;

const tempHome = join(tmpdir(), `hs-global-config-test-${Date.now()}`);
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tempHome };
});

const { readGlobalConfig, writeGlobalConfig } = await import('./global-config.js');

const configPath = join(tempHome, '.hotsheet', 'config.json');

beforeEach(() => {
  try { rmSync(join(tempHome, '.hotsheet'), { recursive: true, force: true }); } catch { /* ignore */ }
});

afterAll(() => {
  try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('readGlobalConfig', () => {
  it('returns {} when file does not exist', () => {
    expect(readGlobalConfig()).toEqual({});
  });

  it('returns {} when file contains invalid JSON', () => {
    mkdirSync(join(tempHome, '.hotsheet'), { recursive: true });
    writeFileSync(configPath, 'not json');
    expect(readGlobalConfig()).toEqual({});
  });

  it('returns {} when file contains unknown fields (strict schema)', () => {
    mkdirSync(join(tempHome, '.hotsheet'), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ unknownField: true }));
    expect(readGlobalConfig()).toEqual({});
  });
});

describe('writeGlobalConfig', () => {
  it('writes config and readGlobalConfig reads it back', () => {
    const result = writeGlobalConfig({ channelEnabled: true });
    expect(result).toEqual({ channelEnabled: true });
    expect(readGlobalConfig()).toEqual({ channelEnabled: true });
  });

  it('merges with existing config', () => {
    writeGlobalConfig({ channelEnabled: true, shareTotalSeconds: 100 });
    const merged = writeGlobalConfig({ shareAccepted: true });
    expect(merged).toEqual({
      channelEnabled: true,
      shareTotalSeconds: 100,
      shareAccepted: true,
    });
    expect(readGlobalConfig()).toEqual(merged);
  });

  it('overwrites existing keys when merging', () => {
    writeGlobalConfig({ shareTotalSeconds: 50 });
    const merged = writeGlobalConfig({ shareTotalSeconds: 200 });
    expect(merged.shareTotalSeconds).toBe(200);
    expect(readGlobalConfig().shareTotalSeconds).toBe(200);
  });

  it('creates .hotsheet directory if it does not exist', () => {
    // tempHome exists but .hotsheet does not
    const result = writeGlobalConfig({ channelEnabled: false });
    expect(result).toEqual({ channelEnabled: false });
    expect(readGlobalConfig()).toEqual({ channelEnabled: false });
  });
});

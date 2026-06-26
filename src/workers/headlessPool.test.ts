// HS-9110 (docs/100 §100.2.1(a)) — the server-readable headless-pool enable,
// against real temp settings files. Tolerates both the native boolean shape
// (`writeFileSettings`) and the stringified shape the project settings API writes.
import { mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { writeFileSettings, writeProjectSettings } from '../file-settings.js';
import { HEADLESS_POOL_SETTING_KEY, isHeadlessPoolEnabled } from './headlessPool.js';

describe('isHeadlessPoolEnabled (HS-9110)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'hs-headless-')); mkdirSync(dir, { recursive: true }); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('defaults to false when unset', () => {
    expect(isHeadlessPoolEnabled(dir)).toBe(false);
  });

  it('reads a native boolean true', () => {
    writeFileSettings(dir, { [HEADLESS_POOL_SETTING_KEY]: true });
    expect(isHeadlessPoolEnabled(dir)).toBe(true);
  });

  it('reads the stringified "true" the project settings API writes', () => {
    writeProjectSettings(dir, { [HEADLESS_POOL_SETTING_KEY]: 'true' });
    expect(isHeadlessPoolEnabled(dir)).toBe(true);
  });

  it('treats "false" / other values as disabled', () => {
    writeProjectSettings(dir, { [HEADLESS_POOL_SETTING_KEY]: 'false' });
    expect(isHeadlessPoolEnabled(dir)).toBe(false);
  });
});

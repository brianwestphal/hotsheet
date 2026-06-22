import { afterEach, describe, expect, it } from 'vitest';

import { isTestMode, setTestMode } from './test-mode.js';

// HS-8921 — process-global test-mode flag (mirrors demo-mode). Also exercised
// end-to-end via cli/args.test.ts (parseArgs flips it on `--test`); this pins
// the get/set contract directly.
describe('test-mode (HS-8921)', () => {
  afterEach(() => setTestMode(false));

  it('defaults to false', () => {
    expect(isTestMode()).toBe(false);
  });

  it('reflects the last setTestMode call', () => {
    setTestMode(true);
    expect(isTestMode()).toBe(true);
    setTestMode(false);
    expect(isTestMode()).toBe(false);
  });
});

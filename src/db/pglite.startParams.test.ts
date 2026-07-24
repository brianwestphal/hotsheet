/**
 * HS-9426 (docs/127) — the drift guard the ticket required.
 *
 * `PGLITE_DEFAULT_START_PARAMS` in `pglite.ts` is a verbatim copy of PGLite's
 * UNEXPORTED internal `defaultStartParams`. We must reproduce it because passing
 * `startParams` REPLACES that list — an incomplete copy bricks cluster init. This
 * test reads the bundled `dist` and fails loudly if our copy has drifted from
 * PGLite's, which is exactly what would happen on an upgrade that changed the
 * defaults. When it fails: re-copy the `defaultStartParams=[…]` array from the
 * dist into `pglite.ts` (and re-verify the WAL-budget behavior still holds).
 *
 * The behavior half (telemetry clusters actually get the small WAL budget, main
 * clusters keep the default) is exercised against a real cluster in
 * `connection.telemetryWal.test.ts`.
 */
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { describe, expect, it } from 'vitest';

import { PGLITE_DEFAULT_START_PARAMS, TELEMETRY_START_PARAMS } from './pglite.js';

/** Pull `defaultStartParams=[…string literals…]` out of the bundled PGLite dist. */
function extractPgliteDefaults(): string[] {
  const require = createRequire(import.meta.url);
  // Resolve the actual on-disk entry the app imports, so we read the same build.
  const entry = require.resolve('@electric-sql/pglite');
  const src = readFileSync(entry, 'utf-8');
  const m = /defaultStartParams\s*=\s*(\[[^\]]*\])/.exec(src);
  if (m === null) {
    throw new Error(
      'Could not find `defaultStartParams=[…]` in the PGLite dist. The minified name ' +
      'may have changed on upgrade — inspect the bundle and update this extractor + ' +
      'PGLITE_DEFAULT_START_PARAMS in pglite.ts.',
    );
  }
  // The array is a list of double-quoted string literals; JSON.parse is safe.
  return JSON.parse(m[1]) as string[];
}

describe('PGLITE_DEFAULT_START_PARAMS drift guard (HS-9426)', () => {
  it('matches the bundled PGLite defaultStartParams exactly', () => {
    const bundled = extractPgliteDefaults();
    expect(
      [...PGLITE_DEFAULT_START_PARAMS],
      'Our copy of PGLite defaultStartParams has drifted from the bundled dist. ' +
      'Re-copy the array into pglite.ts (HS-9426) and re-verify the WAL-budget behavior.',
    ).toEqual(bundled);
  });

  it('TELEMETRY_START_PARAMS is the defaults plus exactly the WAL budget', () => {
    // Guards against someone editing the defaults and forgetting the telemetry
    // extension, or vice-versa.
    expect([...TELEMETRY_START_PARAMS]).toEqual([
      ...PGLITE_DEFAULT_START_PARAMS,
      '-c', 'max_wal_size=64MB',
      '-c', 'min_wal_size=32MB',
    ]);
  });
});

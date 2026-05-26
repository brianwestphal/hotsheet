/**
 * HS-8635 test helper — wire the typed-API layer (`src/api/*`) to the REAL
 * `api` / `apiWithSecret` runtime, mirroring the delegation `app.tsx` installs
 * at boot. Tests that stub the global `fetch` and assert on request URLs use
 * this so a domain migrated onto typed callers still drives the same real
 * `api()` → `fetch` path under test. Call in `beforeEach`; reset with
 * `setApiTransport(null as unknown as ApiTransport)` in `afterEach`.
 */
import { type ApiTransport, setApiTransport } from '../../api/_runner.js';
import { api, apiWithSecret } from '../api.js';

export function wireRealApiTransport(): void {
  setApiTransport((path, opts) =>
    opts.secret !== undefined
      ? apiWithSecret(path, opts.secret, { method: opts.method, body: opts.body })
      : api(path, { method: opts.method, body: opts.body, skipProjectScope: opts.skipProjectScope }),
  );
}

export function resetApiTransport(): void {
  setApiTransport(null as unknown as ApiTransport);
}

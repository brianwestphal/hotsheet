/**
 * HS-8638 — client freeze-reporter typed-API module.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiCallOpts, type ApiTransport, setApiTransport } from './_runner.js';
import { ClientFreezeReportSchema, reportClientFreeze } from './diagnostics.js';

let lastCall: { path: string; opts: ApiCallOpts } | undefined;
function stub(result: unknown): void {
  setApiTransport(vi.fn<ApiTransport>((path, opts) => { lastCall = { path, opts }; return Promise.resolve(result); }));
}
afterEach(() => { setApiTransport(null as unknown as ApiTransport); lastCall = undefined; });

describe('diagnostics domain (HS-8638)', () => {
  it('ClientFreezeReportSchema accepts a report, rejects a non-client source', () => {
    expect(ClientFreezeReportSchema.safeParse({ ts: 't', source: 'client-observer', durationMs: 120, context: 'x' }).success).toBe(true);
    expect(ClientFreezeReportSchema.safeParse({ ts: 't', source: 'server-heartbeat', durationMs: 1, context: 'x' }).success).toBe(false);
  });

  it('reportClientFreeze → POST /diagnostics/freeze', async () => {
    stub({ ok: true });
    const report = { ts: '2026-05-27T00:00:00Z', source: 'client-heartbeat' as const, durationMs: 200, context: 'tick' };
    await reportClientFreeze(report);
    expect(lastCall).toEqual({ path: '/diagnostics/freeze', opts: { method: 'POST', body: report } });
  });
});

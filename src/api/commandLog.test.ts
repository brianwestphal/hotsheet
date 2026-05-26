/**
 * HS-8638 — commands-log typed-API module.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiCallOpts, type ApiTransport, setApiTransport } from './_runner.js';
import { clearCommandLog, CommandLogEntrySchema, getCommandLog, getCommandLogCount } from './commandLog.js';

const row = { id: 1, event_type: 'shell_command', direction: 'outgoing', summary: 'npm test', detail: '…', created_at: '2026-05-27T00:00:00Z' };

let lastCall: { path: string; opts: ApiCallOpts } | undefined;
function stub(result: unknown): void {
  setApiTransport(vi.fn<ApiTransport>((path, opts) => { lastCall = { path, opts }; return Promise.resolve(result); }));
}
afterEach(() => { setApiTransport(null as unknown as ApiTransport); lastCall = undefined; });

describe('commandLog domain (HS-8638)', () => {
  it('CommandLogEntrySchema accepts a full row, rejects a missing field', () => {
    expect(CommandLogEntrySchema.safeParse(row).success).toBe(true);
    const { detail: _d, ...noDetail } = row;
    expect(CommandLogEntrySchema.safeParse(noDetail).success).toBe(false);
  });

  it('getCommandLog → GET /command-log with query string', async () => {
    stub([row]);
    expect(await getCommandLog()).toEqual([row]);
    expect(lastCall?.path).toBe('/command-log');
    await getCommandLog({ limit: 50, search: 'git' });
    expect(lastCall?.path).toBe('/command-log?limit=50&search=git');
  });

  it('clearCommandLog → DELETE /command-log', async () => {
    stub({ ok: true });
    await clearCommandLog();
    expect(lastCall).toEqual({ path: '/command-log', opts: { method: 'DELETE' } });
  });

  it('getCommandLogCount → GET /command-log/count, unwrapped', async () => {
    stub({ count: 12 });
    expect(await getCommandLogCount({ event_type: 'shell_command' })).toBe(12);
    expect(lastCall?.path).toBe('/command-log/count?event_type=shell_command');
  });
});

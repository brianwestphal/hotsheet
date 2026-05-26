/**
 * HS-8631 — channel typed-API module. Verifies the callers hit the right
 * path + method (and forward the cross-project `secret` on permission
 * respond), and that the response schemas accept a real payload / reject a
 * malformed one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiCallOpts, type ApiTransport, setApiTransport } from './_runner.js';
import {
  ChannelStatusSchema, ClaudeVersionCheckSchema, disableChannel, dismissChannelPermission,
  enableChannel, getChannelHeartbeatStatus, getChannelStatus, getClaudeVersionCheck,
  HeartbeatStatusSchema, pollChannelPermission, respondChannelPermission, signalChannelDone,
  triggerChannel,
} from './channel.js';

const status = { enabled: true, alive: true, port: 4174, done: false, versionMismatch: false, serverName: 'hotsheet-channel-x', aliveCount: 1 };
const check = { installed: true, version: '2.1.85', meetsMinimum: true };

let lastCall: { path: string; opts: ApiCallOpts } | undefined;
function stub(result: unknown): void {
  const t = vi.fn<ApiTransport>((path, opts) => { lastCall = { path, opts }; return Promise.resolve(result); });
  setApiTransport(t);
}
afterEach(() => { setApiTransport(null as unknown as ApiTransport); lastCall = undefined; });

describe('channel schemas (HS-8631)', () => {
  it('accepts valid payloads and rejects malformed ones', () => {
    expect(ChannelStatusSchema.safeParse(status).success).toBe(true);
    expect(ChannelStatusSchema.safeParse({ ...status, port: null }).success).toBe(true); // port may be null
    expect(ClaudeVersionCheckSchema.safeParse(check).success).toBe(true);
    expect(ClaudeVersionCheckSchema.safeParse({ ...check, version: null }).success).toBe(true);
    expect(HeartbeatStatusSchema.safeParse({ updates: [{ secret: 's', state: 'idle' }] }).success).toBe(true);
    expect(ChannelStatusSchema.safeParse({ ...status, alive: 'yes' }).success).toBe(false);
    expect(ChannelStatusSchema.safeParse({ ...status, serverName: undefined }).success).toBe(false);
  });
});

describe('channel callers route to the right endpoint (HS-8631)', () => {
  it('getClaudeVersionCheck → GET /channel/claude-check', async () => {
    stub(check);
    expect(await getClaudeVersionCheck()).toEqual(check);
    expect(lastCall?.path).toBe('/channel/claude-check');
  });

  it('getChannelStatus → GET /channel/status', async () => {
    stub(status);
    expect(await getChannelStatus()).toEqual(status);
    expect(lastCall?.path).toBe('/channel/status');
  });

  it('triggerChannel → POST /channel/trigger with message body', async () => {
    stub({ ok: true });
    await triggerChannel('do the thing');
    expect(lastCall).toEqual({ path: '/channel/trigger', opts: { method: 'POST', body: { message: 'do the thing' } } });
  });

  it('pollChannelPermission → GET /channel/permission, forwarding secret', async () => {
    stub({ pending: null });
    await pollChannelPermission('sek');
    expect(lastCall).toEqual({ path: '/channel/permission', opts: { secret: 'sek' } });
  });

  it('respondChannelPermission → POST /channel/permission/respond with body + secret', async () => {
    stub({ decision: 'allow' });
    await respondChannelPermission({ request_id: 'r1', behavior: 'allow', tool_name: 'Bash' }, 'sek');
    expect(lastCall).toEqual({
      path: '/channel/permission/respond',
      opts: { method: 'POST', body: { request_id: 'r1', behavior: 'allow', tool_name: 'Bash' }, secret: 'sek' },
    });
  });

  it('dismissChannelPermission / signalChannelDone / enableChannel / disableChannel → POST ok endpoints', async () => {
    stub({ ok: true });
    await dismissChannelPermission('sek');
    expect(lastCall).toEqual({ path: '/channel/permission/dismiss', opts: { method: 'POST', secret: 'sek' } });
    await signalChannelDone();
    expect(lastCall).toEqual({ path: '/channel/done', opts: { method: 'POST' } });
    await enableChannel();
    expect(lastCall?.path).toBe('/channel/enable');
    await disableChannel();
    expect(lastCall?.path).toBe('/channel/disable');
  });

  it('getChannelHeartbeatStatus → GET /channel/heartbeat-status', async () => {
    stub({ updates: [] });
    expect(await getChannelHeartbeatStatus()).toEqual({ updates: [] });
    expect(lastCall?.path).toBe('/channel/heartbeat-status');
  });

  it('rejects a status response that fails schema validation', async () => {
    stub({ ...status, aliveCount: 'one' });
    await expect(getChannelStatus()).rejects.toThrow(/response shape mismatch/);
  });
});

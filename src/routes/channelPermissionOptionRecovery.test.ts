/**
 * HS-9586 — `/channel/permission/respond` must never turn an Allow into a refusal.
 *
 * The route resolves an ACP request with the chosen `option_id`. When that field was
 * absent it fell through to `{ cancelled: true }` — a REFUSAL — even though the body
 * carried `behavior: 'allow'`. `behavior` is REQUIRED by `PermissionRespondSchema`,
 * so "no option_id" never meant "the user dismissed the popup"; it only ever meant
 * the client rendered the legacy Allow/Deny layout, which is what a client does when
 * it didn't receive the options (the actual HS-9586 defect, upstream in
 * `api/projects.ts`). The result was silent: the user clicked Allow and codex was
 * told no, with no error on either side.
 *
 * The schema fix stops the options being lost; this fallback makes the failure mode
 * unreachable even from a stale client bundle, which is exactly the window where a
 * silent allow→deny inversion is most likely and least debuggable.
 *
 * The reply shape asserted here (`{ optionId }` vs `{ cancelled }`) is what
 * `codexAppServerMapping::approvalResponseFromReply` translates into codex's wire
 * vocabulary — `codexApprovalLive.test.ts` covers that half against the real binary.
 */
import { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  _resetAcpPermissionsForTesting,
  type AcpPermissionReply,
  injectAcpPermission,
} from '../acp/acpPermissionBridge.js';
import { cleanupTestDb, setupTestDb } from '../test-helpers.js';
import type { AppEnv } from '../types.js';
import { channelRoutes } from './channel.js';

vi.mock('../channelRegistry.js', () => ({
  listAliveEntries: vi.fn(() => []),
  disconnectMainConnections: vi.fn(),
}));

/** The options a codex shell-command approval is raised with (docs/121 §121.13). */
const CODEX_OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'allow_session', name: 'Allow for session', kind: 'allow_always' },
  { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
];

describe('permission respond — option-id recovery (HS-9586)', () => {
  let tempDir: string;
  let app: Hono<AppEnv>;

  beforeAll(async () => {
    tempDir = await setupTestDb();
    app = new Hono<AppEnv>();
    app.use('*', async (c, next) => { c.set('dataDir', tempDir); c.set('projectSecret', 'sek'); await next(); });
    app.route('/api', channelRoutes);
  });

  afterAll(async () => { await cleanupTestDb(tempDir); });

  afterEach(() => { _resetAcpPermissionsForTesting(); });

  /** Raise a pending ACP permission and capture how it is ultimately answered. */
  function raise(options = CODEX_OPTIONS): { request_id: string; reply: () => Promise<AcpPermissionReply> } {
    const { request_id, promise } = injectAcpPermission({
      secret: 'sek', tool_name: 'Codex: Shell command', description: 'run it',
      input_preview: 'npm install motion', options,
    });
    return { request_id, reply: () => promise };
  }

  async function respond(body: Record<string, unknown>): Promise<Response> {
    return app.request('/api/channel/permission/respond', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('an explicit option_id is used verbatim — unchanged behavior', async () => {
    const { request_id, reply } = raise();
    const res = await respond({ request_id, behavior: 'allow', option_id: 'allow_session' });
    expect(res.status).toBe(200);
    await expect(reply()).resolves.toEqual({ optionId: 'allow_session' });
  });

  it('behavior:allow with NO option_id resolves as an ALLOW, not a cancellation', async () => {
    // The regression itself. Pre-fix this resolved `{ cancelled: true }`, which the
    // codex drive translates to `decline`/`cancel` — the user's "yes" read as "no".
    const { request_id, reply } = raise();
    const res = await respond({ request_id, behavior: 'allow' });
    expect(res.status).toBe(200);
    await expect(reply()).resolves.toEqual({ optionId: 'allow' });
  });

  it('behavior:deny with NO option_id resolves as a DENY — recovery is not "always allow"', async () => {
    const { request_id, reply } = raise();
    await respond({ request_id, behavior: 'deny' });
    await expect(reply()).resolves.toEqual({ optionId: 'deny' });
  });

  it('an empty-string option_id is treated as absent, not as an unknown option', async () => {
    // `choiceFromReply` denies unrecognized ids, so passing '' through would have
    // reinstated the bug in a form the previous case doesn't cover.
    const { request_id, reply } = raise();
    await respond({ request_id, behavior: 'allow', option_id: '' });
    await expect(reply()).resolves.toEqual({ optionId: 'allow' });
  });

  it('recovery uses the AGENT\'s own ids, not the literals codex happens to use', async () => {
    // An ACP agent supplies its own vocabulary (docs/114); recovering a hard-coded
    // 'allow' would be rejected by that agent as an unknown option.
    const { request_id, reply } = raise([
      { optionId: 'proceed-once', name: 'Yes', kind: 'allow_once' },
      { optionId: 'refuse', name: 'No', kind: 'reject_once' },
    ]);
    await respond({ request_id, behavior: 'allow' });
    await expect(reply()).resolves.toEqual({ optionId: 'proceed-once' });
  });

  it('falls back to cancellation when the agent offers no option of the needed kind', async () => {
    // Nothing valid to send: cancelling is correct here, and it is the only place
    // the route may still cancel on an allow.
    const { request_id, reply } = raise([{ optionId: 'refuse', name: 'No', kind: 'reject_once' }]);
    await respond({ request_id, behavior: 'allow' });
    await expect(reply()).resolves.toEqual({ cancelled: true });
  });

  it('prefers allow_once over allow_always — recovery must not silently widen scope', async () => {
    // A user who clicked plain Allow must not be upgraded to allow-for-session.
    const { request_id, reply } = raise([
      { optionId: 'always', name: 'Allow always', kind: 'allow_always' },
      { optionId: 'once', name: 'Allow', kind: 'allow_once' },
      { optionId: 'no', name: 'Deny', kind: 'reject_once' },
    ]);
    await respond({ request_id, behavior: 'allow' });
    await expect(reply()).resolves.toEqual({ optionId: 'once' });
  });
});

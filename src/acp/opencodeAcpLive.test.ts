/**
 * HS-9432 — LOCAL-ONLY live test for the OpenCode ACP handshake, against the REAL
 * `opencode acp` agent. Like `codexModelBLive.test.ts` (and the live-GitHub tests),
 * it `describe.skipIf`s when the tool isn't installed, so CI skips it.
 *
 * Why: `acpClient.ts` / `acpDrive.ts` are exhaustively unit-tested against a
 * SCRIPTED mock agent replaying captured OpenCode messages — but nothing confirms
 * the real `opencode` binary still speaks the ACP v1 contract Hot Sheet's driver
 * assumes. This exercises the real spawn + framing (`resolveAcpAgentCommand` +
 * `acpFraming`) + the `initialize` handshake against the installed opencode, so a
 * future opencode release that changes the protocol is caught here, not by a user.
 *
 * Cost-free + side-effect-bounded: only the ACP `initialize` handshake — NO
 * `session/prompt`, so no LLM turn, no spend, and `opencode auth` isn't required
 * (initialize succeeds unauthenticated; it even advertises the auth methods). The
 * child is killed and the temp cwd removed on teardown.
 */
import { type ChildProcess, spawn } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it } from 'vitest';

import { isExecutableOnPath } from '../utils/isExecutableOnPath.js';
import { ACP_PROTOCOL_VERSION, resolveAcpAgentCommand } from './acpAgents.js';
import { createNdjsonDecoder, encodeMessage } from './acpFraming.js';

const opencodePresent = isExecutableOnPath('opencode');

describe.skipIf(!opencodePresent)('OpenCode ACP live handshake (HS-9432)', () => {
  let child: ChildProcess | null = null;
  let cwd: string | null = null;

  afterAll(() => {
    try { child?.kill('SIGTERM'); } catch { /* already gone */ }
    if (cwd !== null) rmSync(cwd, { recursive: true, force: true });
  });

  it('real `opencode acp` answers `initialize` with ACP protocol v1 (drift guard)', async () => {
    const resolved = resolveAcpAgentCommand('opencode');
    expect(resolved).not.toBeNull(); // command-resolution contract
    cwd = mkdtempSync(join(tmpdir(), 'hs-oc-acp-'));

    // Defensive: don't leak the vitest fork's module loader into a spawned real CLI
    // (`opencode` is its own runtime; inheriting NODE_OPTIONS/VITEST_* is never what
    // the production drive `acpDrive.ts` does — it runs outside vitest).
    const env: NodeJS.ProcessEnv = { ...process.env, HOTSHEET_DRIVE_SPAWNED: '1' };
    Reflect.deleteProperty(env, 'NODE_OPTIONS');
    for (const k of Object.keys(env)) if (k.startsWith('VITEST')) Reflect.deleteProperty(env, k);

    child = spawn(resolved!.command, resolved!.args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });

    const decoder = createNdjsonDecoder();
    const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('opencode acp initialize timeout')), 20_000);
      timer.unref();
      child!.on('error', (e) => { clearTimeout(timer); reject(e); }); // e.g. ENOENT
      child!.stdout!.on('data', (chunk: Buffer) => {
        for (const msg of decoder.push(chunk.toString('utf8'))) {
          if (msg.id === 1 && typeof msg.result === 'object' && msg.result !== null) {
            clearTimeout(timer);
            resolve(msg.result as Record<string, unknown>);
          }
        }
      });
      // The exact request the driver sends (acpClient.ts): initialize with our fs caps.
      child!.stdin!.write(encodeMessage({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } } },
      }));
    });

    // The stable contract the driver depends on: ACP v1. (agentCapabilities/
    // authMethods vary across opencode versions, so don't over-pin them.)
    expect(result.protocolVersion).toBe(ACP_PROTOCOL_VERSION);
  }, 25_000);
});

/**
 * HS-9586 — LOCAL-ONLY live end-to-end test of a codex approval, against the REAL
 * `codex app-server` binary running a REAL LLM turn.
 *
 * ## Why this exists, when a schema-contract test already did
 *
 * The first HS-9586 fix was built entirely against
 * `codex app-server generate-json-schema`, and `codexApprovalSchemaContract.test.ts`
 * validates the drive's payloads against it. That test passed — and the bug was
 * still live, because **the generated schema is not the authority on what the
 * running server accepts for a given method**. It says
 * `ExecCommandApprovalResponse.decision` accepts `approved`; it cannot say which
 * server-request a real turn actually raises. A real 0.146.0 turn raises
 * `item/commandExecution/requestApproval`, whose vocabulary is `accept`.
 *
 * So the previous coverage could only prove "this payload is a valid instance of
 * some schema". This test proves the thing the user actually cares about:
 *
 *   **the user clicked Allow → codex ran the command.**
 *
 * The assertion is a marker file on disk that only the approved command creates.
 * Nothing about that is our own vocabulary on both sides of an `expect`, which is
 * the specific weakness that let the bug survive two rounds of green tests.
 *
 * ## Both directions, deliberately
 *
 * A positive-only test would pass against a drive that approved everything, and a
 * negative-only one against a drive that approved nothing. Neither failure mode is
 * hypothetical — "always deny" is exactly the bug being fixed, and "always allow"
 * is what an over-eager fix would produce. The marker file must exist after Allow
 * and NOT exist after Deny.
 *
 * ## Why it is opt-in
 *
 * It spawns codex, runs an LLM turn (network, tokens, ~15-30 s) and executes a
 * shell command. That is too slow and too side-effecting for `npm test`, so it is
 * gated on `HOTSHEET_CODEX_LIVE=1` AND the binary being present. In CI both are
 * absent and the block is skipped.
 *
 *   HOTSHEET_CODEX_LIVE=1 npx vitest run src/codexApprovalLive.test.ts
 *
 * The command it approves is `touch <file-in-a-temp-dir>` — the smallest command
 * whose execution is observable, confined to a throwaway directory.
 */
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  _resetAcpPermissionsForTesting,
  type AcpPendingPermission,
  pendingAcpPermissionForSecret,
  resolveAcpPermission,
} from './acp/acpPermissionBridge.js';
import { _resetCodexAppServersForTesting, shutdownCodexAppServers, spawnCodexAppServerRun } from './codexAppServer.js';
import { getProjectSecret } from './secret-file.js';

const LIVE = process.env.HOTSHEET_CODEX_LIVE === '1';

function codexPresent(): boolean {
  try {
    execFileSync('codex', ['--version'], { stdio: 'ignore', timeout: 10_000, killSignal: 'SIGKILL' });
    return true;
  } catch { return false; }
}

const ENABLED = LIVE && codexPresent();

/** Force the stdio child rather than the shared daemon: a turn on the user's live
 *  daemon thread would be visible in their terminal and would mutate real state. */
const noDaemon = (): Promise<null> => Promise.resolve(null);

const TURN_TIMEOUT_MS = 180_000;

async function waitFor<T>(probe: () => T | null, timeoutMs: number, what: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = probe();
    if (v !== null) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => { const t = setTimeout(r, 250); t.unref(); });
  }
}

describe.skipIf(!ENABLED)('codex approval → real command execution (HS-9586, live)', () => {
  const dirs: string[] = [];

  afterEach(() => {
    shutdownCodexAppServers();
    _resetCodexAppServersForTesting();
    _resetAcpPermissionsForTesting();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  /**
   * Run one live approval, answering the overlay with `pickOption`. Returns whether
   * the approved command actually ran.
   *
   * `pickOption` receives the SAME `options` array the browser overlay renders as
   * buttons, and must return one of their `optionId`s — so the test exercises the
   * real id vocabulary the UI round-trips, not a literal restated here.
   */
  async function runApproval(
    pickOption: (pending: AcpPendingPermission) => string | null,
  ): Promise<{ ran: boolean; pending: AcpPendingPermission }> {
    const projectDir = mkdtempSync(join(tmpdir(), 'hs-codex-live-'));
    dirs.push(projectDir);
    const dataDir = join(projectDir, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ ai_tool: 'codex', codex_interactive_permissions: true }), 'utf-8');
    // A file so the workspace looks like a real project to codex.
    writeFileSync(join(projectDir, 'README.md'), 'live approval probe\n', 'utf-8');

    const marker = join(projectDir, 'approval-marker.txt');
    expect(existsSync(marker)).toBe(false);

    const started = spawnCodexAppServerRun(
      dataDir,
      4174,
      `Run exactly this shell command and nothing else, then stop: touch ${marker}`,
      { connectDaemon: noDaemon, postHeartbeat: vi.fn(), signalDone: vi.fn(), postTranscript: vi.fn() },
    );
    expect(started).toBe(true);

    const secret = getProjectSecret(dataDir);
    const pending = await waitFor(() => pendingAcpPermissionForSecret(secret), TURN_TIMEOUT_MS, 'the approval overlay');

    const optionId = pickOption(pending);
    resolveAcpPermission(pending.request_id, optionId === null ? { cancelled: true } : { optionId });

    // The command (if approved) runs after the reply. Poll for the marker rather
    // than sleeping a fixed amount, so a fast machine isn't kept waiting — but a
    // NEGATIVE result still has to wait out the full window, because "not yet" and
    // "never" are indistinguishable early. `WAIT_MS` is the cost of proving a deny.
    const WAIT_MS = 15_000;
    const deadline = Date.now() + WAIT_MS;
    let ran = false;
    while (Date.now() < deadline) {
      if (existsSync(marker)) { ran = true; break; }
      await new Promise((r) => { const t = setTimeout(r, 250); t.unref(); });
    }
    return { ran, pending };
  }

  it('ALLOW runs the command — the whole point of the ticket', async () => {
    const { ran, pending } = await runApproval((p) => {
      // The overlay's allow button is the `allow_once` kind; take its id from the
      // options the server actually sent rather than hard-coding one here.
      const allow = p.options.find(o => o.kind === 'allow_once');
      expect(allow, 'the overlay must offer an allow option').toBeDefined();
      return allow!.optionId;
    });
    expect(pending.tool_name).toBe('Codex: Shell command');
    expect(pending.input_preview).toContain('touch');
    expect(ran, 'codex must actually execute the command the user approved').toBe(true);
  }, TURN_TIMEOUT_MS + 60_000);

  it('DENY does not run the command — an always-allow fix would fail here', async () => {
    const { ran } = await runApproval((p) => {
      const deny = p.options.find(o => o.kind.startsWith('reject'));
      expect(deny, 'the overlay must offer a deny option').toBeDefined();
      return deny!.optionId;
    });
    expect(ran, 'a denied command must not run').toBe(false);
  }, TURN_TIMEOUT_MS + 60_000);

  it('a DISMISSED overlay does not run the command', async () => {
    const { ran } = await runApproval(() => null); // null → { cancelled: true }
    expect(ran, 'dismissing the popup must not be read as approval').toBe(false);
  }, TURN_TIMEOUT_MS + 60_000);
});

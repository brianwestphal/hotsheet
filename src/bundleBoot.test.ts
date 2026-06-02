import { execFileSync, spawn } from 'child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// HS-8706 — REGRESSION GUARD for the whole "the BUNDLE crashes on boot" class.
//
// The installed app's MCP channel server "wouldn't connect" because the bundled
// `dist/channel.js` threw at module-load time:
//
//   TypeError: Class2 is not a constructor   (zod's ZodCustom, undefined)
//
// `@modelcontextprotocol/sdk@1.29.0`'s `types.js` runs top-level `z.custom()`
// calls; esbuild's lazy ESM init ran the SDK module before zod's, so zod's
// `ZodCustom` class wasn't initialized yet. The critical property of this bug
// class: **it does NOT reproduce under `tsx` / vitest** — Node's real ESM
// loader gets the init order right, and the existing e2e suite boots the server
// via `tsx` too (NODE_V8_COVERAGE + `node --import tsx`), NOT the bundle. So
// nothing in the suite exercised the shipped artifact, and the crash sailed
// through green all the way to a release.
//
// These tests run the ACTUAL bundles the app ships and assert they load:
//   - `channel.js` — boot it as the MCP stdio server exactly the way Claude
//     Code spawns it from `.mcp.json`, and drive an `initialize` + `tools/list`
//     handshake (proves MCP works, not just that it loaded).
//   - `cli.js` — load the whole module via `--help` (which runs every top-level
//     module initializer, where a zod-style init-order crash lives, then exits
//     0). A lightweight load-smoke for the main server bundle.
//
// Companion: `channelBundle.test.ts` pins the static config contract (zod stays
// external + is shipped by build-sidecar.sh); this file proves the artifacts
// actually run. Any future bundling / init-order / missing-export regression in
// either server bundle fails here before a release ships it.

const repoRoot = process.cwd();
const cliBundle = join(repoRoot, 'dist', 'cli.js');
const channelBundle = join(repoRoot, 'dist', 'channel.js');

/** Build the server bundles if missing or older than their sources. dist/ is
 *  gitignored, so CI (clean checkout) always builds; locally we skip the ~2s
 *  rebuild when the artifacts are already fresh. */
function ensureBundlesBuilt(): void {
  const sources = [
    join(repoRoot, 'src', 'channel.ts'),
    join(repoRoot, 'src', 'cli.ts'),
    join(repoRoot, 'tsup.config.ts'),
  ];
  const newestSource = Math.max(...sources.filter(existsSync).map(s => statSync(s).mtimeMs));
  const fresh = [cliBundle, channelBundle].every(b => existsSync(b) && statSync(b).mtimeMs >= newestSource);
  if (fresh) return;
  execFileSync('npx', ['tsup', '--config', 'tsup.config.ts'], {
    cwd: repoRoot,
    timeout: 180_000,
    stdio: 'ignore',
  });
}

interface JsonRpcMessage { id?: number; result?: unknown; error?: unknown }

/** Spawn the bundled channel server, run the MCP handshake over stdio, and
 *  return the `initialize` + `tools/list` responses. Rejects (failing the test)
 *  if the process crashes on boot or the handshake times out. */
async function bootChannelAndHandshake(dataDir: string): Promise<{ initialize: JsonRpcMessage; toolsList: JsonRpcMessage }> {
  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [channelBundle, '--data-dir', dataDir], {
      cwd: repoRoot,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    const seen = new Map<number, JsonRpcMessage>();
    let settled = false;

    const timer = setTimeout(() => fail(`handshake timed out. stderr:\n${stderr}`), 30_000);

    function cleanup(): void {
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    function fail(msg: string): void {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(msg));
    }
    function done(): void {
      if (settled) return;
      const initialize = seen.get(1);
      const toolsList = seen.get(2);
      if (!initialize || !toolsList) return;
      settled = true;
      cleanup();
      resolve({ initialize, toolsList });
    }

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
      let nl: number;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl).trim();
        stdout = stdout.slice(nl + 1);
        if (line === '') continue;
        let msg: JsonRpcMessage;
        try { msg = JSON.parse(line) as JsonRpcMessage; } catch { continue; }
        if (typeof msg.id === 'number') seen.set(msg.id, msg);
        if (seen.has(1) && !seen.has(2)) {
          // initialize answered — send the initialized notification + tools/list.
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`);
        }
        done();
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('error', (err) => fail(`failed to spawn channel bundle: ${err.message}`));
    child.on('exit', (code) => {
      // A boot crash (the bug this test exists for) exits before answering.
      if (!seen.has(1)) fail(`channel bundle exited (code ${code}) before completing the handshake. stderr:\n${stderr}`);
    });

    // Kick off the handshake.
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bundle-boot-test', version: '0' } },
    })}\n`);
  });
}

describe('bundled channel.js boots as an MCP server (HS-8706)', () => {
  let dataDir: string;

  beforeAll(() => {
    ensureBundlesBuilt();
    dataDir = mkdtempSync(join(tmpdir(), 'hs-channel-boot-'));
  }, 200_000);

  afterAll(() => {
    if (dataDir) { try { rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('completes the MCP initialize handshake without crashing on load', async () => {
    const { initialize } = await bootChannelAndHandshake(dataDir);
    expect(initialize.error).toBeUndefined();
    const serverInfo = (initialize.result as { serverInfo?: { name?: string } } | undefined)?.serverInfo;
    expect(serverInfo?.name).toMatch(/^hotsheet-channel-/);
  });

  it('serves the hotsheet_* tool surface via tools/list', async () => {
    const { toolsList } = await bootChannelAndHandshake(dataDir);
    expect(toolsList.error).toBeUndefined();
    const tools = (toolsList.result as { tools?: { name?: string }[] } | undefined)?.tools ?? [];
    const names = tools.map(t => t.name);
    // The 14-tool surface (HS-8346/8347). Assert a representative core is present
    // — proves the bundle not only loaded but wired its request handlers.
    expect(names.length).toBeGreaterThanOrEqual(10);
    expect(names).toContain('hotsheet_signal_done');
    expect(names).toContain('hotsheet_update_ticket');
    expect(names).toContain('hotsheet_create_ticket');
  });
});

describe('bundled cli.js loads without crashing (HS-8706)', () => {
  let home: string;

  beforeAll(() => {
    ensureBundlesBuilt();
    // Isolate HOME so the load-smoke can't touch the real ~/.hotsheet (instance
    // file, projects list, global config) or the running instance.
    home = mkdtempSync(join(tmpdir(), 'hs-cli-smoke-home-'));
  }, 200_000);

  afterAll(() => {
    if (home) { try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ } }
  });

  it('runs every top-level module initializer via --help and exits cleanly', () => {
    // `--help` imports the ENTIRE bundle (where a zod-style init-order crash
    // lives — it fires during module load, before `main()`), prints usage, and
    // exits 0. A boot crash would exit non-zero with a stack instead, throwing
    // here. No server starts, no port binds, no global state outside isolated
    // HOME is touched.
    const out = execFileSync(process.execPath, [cliBundle, '--help'], {
      cwd: repoRoot,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
      timeout: 30_000,
    });
    expect(out).toContain('Usage:');
    expect(out).toContain('--data-dir');
  });
});

/**
 * HS-9436 — LOCAL-ONLY live CLI-contract test for the Codex MCP config writer,
 * against the REAL `codex` binary (skips unless `codex` is on PATH, like the
 * live-GitHub / codex-model-B tests). Cost-free: no LLM turn — it only exercises
 * `codex mcp add` (the TOML write Hot Sheet drives) + `codex mcp list --json`
 * (the read-back), both against a THROWAWAY `$CODEX_HOME` so the user's real
 * `~/.codex/config.toml` is never touched.
 *
 * Why a LIVE test on top of the `src/codex.test.ts` unit tests (which inject a
 * fake `runCodex`): the unit tests prove we build the right `codex mcp add`
 * argv, but they can't prove the real `codex` ACCEPTS that argv and reads the
 * entry back in the shape we expect. This catches codex changing its
 * `mcp add` / `mcp list` contract (flag rename, TOML layout, `--json` schema)
 * before a user hits it — the exact drift the manual per-tool config check
 * existed for.
 *
 * The AGENTS.md thin-adapter + `.agents/skills` half of the codex integration
 * (docs/118) has no `codex`-CLI surface to list them back, so it stays unit-
 * tested (`src/skills.test.ts`); this covers the MCP-config contract only.
 */
import { execFileSync } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { getChannelServerPath } from './channel-config.js';
import { CODEX_MCP_KEY, ensureCodexMcpConfig } from './codex.js';

/** True when a CLI is runnable here. Sync child-process rule: `timeout` +
 *  `killSignal: 'SIGKILL'` (a hung `--version` must not wedge collection). */
function cliPresent(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 5000, killSignal: 'SIGKILL' });
    return true;
  } catch {
    return false;
  }
}

const codexPresent = cliPresent('codex');

// The `codex mcp list --json` rows we assert on (a subset of the real schema).
const McpListSchema = z.array(z.object({
  name: z.string(),
  transport: z.object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
  }).optional(),
}));

describe.skipIf(!codexPresent)('codex MCP config CLI contract (HS-9436) (skipped: codex not on PATH)', () => {
  let codexHome: string;
  let prevCodexHome: string | undefined;

  beforeAll(() => {
    codexHome = mkdtempSync(join(tmpdir(), 'hs-codex-home-'));
    prevCodexHome = process.env.CODEX_HOME;
    // Both `ensureCodexMcpConfig` (idempotency precheck via `codexConfigPath()`)
    // and the `codex mcp add`/`list` it shells honor $CODEX_HOME — so the whole
    // round-trip lands in the throwaway dir, never the user's real config.
    process.env.CODEX_HOME = codexHome;
  });

  afterAll(() => {
    if (prevCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prevCodexHome;
    rmSync(codexHome, { recursive: true, force: true });
  });

  it('ensureCodexMcpConfig registers hotsheet-channel that real `codex mcp list --json` reads back', () => {
    // The real production writer shells `codex mcp add`.
    expect(ensureCodexMcpConfig()).toBe(true);  // first run performs the add
    expect(ensureCodexMcpConfig()).toBe(false); // idempotent: text precheck skips the re-add

    const raw = execFileSync('codex', ['mcp', 'list', '--json'], {
      encoding: 'utf8',
      timeout: 15_000,
      killSignal: 'SIGKILL',
      env: { ...process.env, CODEX_HOME: codexHome },
    });
    const servers = McpListSchema.parse(JSON.parse(raw));
    const entry = servers.find((s) => s.name === CODEX_MCP_KEY);
    expect(entry, `codex should list the "${CODEX_MCP_KEY}" server we added`).toBeDefined();

    // The command/args codex read back must match exactly what Hot Sheet asked to
    // register (the channel-server launch). A drift here means codex reshaped its
    // stored transport and our drive would silently lose the hotsheet_* tools.
    const { command, args } = getChannelServerPath();
    expect(entry?.transport?.command).toBe(command);
    expect(entry?.transport?.args).toEqual(args);
  });
});

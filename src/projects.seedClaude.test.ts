import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readFileSettings } from './file-settings.js';
import { seedClaudeTerminalIfNew } from './projects.js';

/**
 * HS-8491 — pin the auto-seed behavior of `seedClaudeTerminalIfNew`.
 *
 * Contract:
 *   - Seeds a `{ id: 'claude', name: 'Claude', command: '{{claudeCommand}}', lazy: true }`
 *     terminal in `.hotsheet/settings.json` when `terminals` is not
 *     yet set AND `claude` is on PATH.
 *   - Does NOT seed when `terminals` is already set (even to an
 *     empty `[]` — the user may have explicitly cleared their list).
 *   - Does NOT seed when `claude` is not on PATH.
 *   - Idempotent: a second call after the seed is a no-op because
 *     `terminals !== undefined`.
 */

const tempRoot = join(tmpdir(), `hs-seed-claude-test-${String(Date.now())}`);
let savedPath: string | undefined;
let fakeBinDir: string;

beforeEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });
  fakeBinDir = join(tempRoot, 'fake-bin');
  mkdirSync(fakeBinDir, { recursive: true });
  savedPath = process.env.PATH;
});

afterEach(() => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
});

afterAll(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

function makeProject(name: string): string {
  const dataDir = join(tempRoot, name, '.hotsheet');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({}));
  return dataDir;
}

function withClaudeOnPath(): void {
  writeFileSync(join(fakeBinDir, 'claude'), '');
  process.env.PATH = fakeBinDir;
}

describe('seedClaudeTerminalIfNew (HS-8491)', () => {
  it('seeds a claude terminal when terminals is unset AND claude is on PATH', () => {
    const dataDir = makeProject('case-a');
    withClaudeOnPath();
    seedClaudeTerminalIfNew(dataDir);
    const settings = readFileSettings(dataDir);
    expect(settings.terminals).toEqual([
      { id: 'claude', name: 'Claude', command: '{{claudeCommand}}', lazy: true },
    ]);
  });

  it('does NOT seed when claude is not on PATH (even if terminals is unset)', () => {
    const dataDir = makeProject('case-b');
    process.env.PATH = ''; // no claude binary anywhere
    seedClaudeTerminalIfNew(dataDir);
    expect(readFileSettings(dataDir).terminals).toBeUndefined();
  });

  it('does NOT seed when terminals is already set (even to an empty array)', () => {
    const dataDir = makeProject('case-c');
    withClaudeOnPath();
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ terminals: [] }));
    seedClaudeTerminalIfNew(dataDir);
    // Stays empty — the user explicitly cleared their list and we
    // must not auto-restore.
    expect(readFileSettings(dataDir).terminals).toEqual([]);
  });

  it('does NOT seed when terminals is already set to a non-empty list', () => {
    const dataDir = makeProject('case-d');
    withClaudeOnPath();
    writeFileSync(
      join(dataDir, 'settings.json'),
      JSON.stringify({ terminals: [{ id: 'shell', command: 'bash' }] }),
    );
    seedClaudeTerminalIfNew(dataDir);
    expect(readFileSettings(dataDir).terminals).toEqual([{ id: 'shell', command: 'bash' }]);
  });

  it('is idempotent — a second call after the seed is a no-op', () => {
    const dataDir = makeProject('case-e');
    withClaudeOnPath();
    seedClaudeTerminalIfNew(dataDir);
    const after1 = readFileSettings(dataDir).terminals;
    seedClaudeTerminalIfNew(dataDir);
    const after2 = readFileSettings(dataDir).terminals;
    expect(after2).toEqual(after1);
  });

  it('writes a real settings.json file (sanity)', () => {
    const dataDir = makeProject('case-f');
    withClaudeOnPath();
    seedClaudeTerminalIfNew(dataDir);
    expect(existsSync(join(dataDir, 'settings.json'))).toBe(true);
  });
});

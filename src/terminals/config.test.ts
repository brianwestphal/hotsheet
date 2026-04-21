import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TERMINAL_ID, findTerminalConfig, listTerminalConfigs } from './config.js';

describe('TerminalConfig loader', () => {
  const cleanup: string[] = [];

  beforeEach(() => { cleanup.length = 0; });
  afterEach(() => {
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
  });

  function dir(settings: Record<string, unknown> = {}): string {
    const root = mkdtempSync(join(tmpdir(), 'hs-termcfg-'));
    const dataDir = join(root, '.hotsheet');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'settings.json'), JSON.stringify(settings));
    cleanup.push(root);
    return dataDir;
  }

  it('returns an implicit default when no terminals setting is present', () => {
    const list = listTerminalConfigs(dir());
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(DEFAULT_TERMINAL_ID);
    expect(list[0].command).toBe('{{claudeCommand}}');
  });

  it('migrates legacy terminal_command/terminal_cwd into a single default entry', () => {
    const list = listTerminalConfigs(dir({
      terminal_command: '/bin/zsh',
      terminal_cwd: '/tmp/override',
    }));
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(DEFAULT_TERMINAL_ID);
    expect(list[0].command).toBe('/bin/zsh');
    expect(list[0].cwd).toBe('/tmp/override');
  });

  it('reads and normalizes the terminals array when present', () => {
    const list = listTerminalConfigs(dir({
      terminals: [
        { id: 'main', name: 'Claude', command: '{{claudeCommand}}' },
        { id: 'logs', name: 'Logs', command: 'tail -f /tmp/app.log', lazy: false },
      ],
    }));
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: 'main', name: 'Claude' });
    expect(list[1]).toMatchObject({ id: 'logs', name: 'Logs', lazy: false });
  });

  it('synthesizes ids for entries missing the id field', () => {
    const list = listTerminalConfigs(dir({
      terminals: [{ command: '/bin/sh' }],
    }));
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe('default-0');
  });

  it('findTerminalConfig returns null for unknown ids', () => {
    const d = dir();
    expect(findTerminalConfig(d, DEFAULT_TERMINAL_ID)).not.toBeNull();
    expect(findTerminalConfig(d, 'no-such-id')).toBeNull();
  });
});

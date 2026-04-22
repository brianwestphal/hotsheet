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

  // HS-6337: no automatic default terminal per project — an unconfigured
  // project returns an empty array, so the drawer shows no tabs until the
  // user explicitly adds one.
  it('returns an empty list when no terminals setting is present (HS-6337)', () => {
    const list = listTerminalConfigs(dir());
    expect(list).toEqual([]);
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

  // HS-6370: pre-fix settings.json files stored the array as a JSON string.
  // Reading must tolerate both shapes so users don't lose their configuration
  // until they re-save through the settings UI.
  it('reads a stringified terminals array (legacy on-disk shape)', () => {
    const list = listTerminalConfigs(dir({
      terminals: '[{"id":"main","name":"Claude","command":"{{claudeCommand}}","lazy":true},{"id":"logs","name":"Logs","command":"tail -f /tmp/app.log"}]',
    }));
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ id: 'main', name: 'Claude' });
    expect(list[1]).toMatchObject({ id: 'logs', name: 'Logs' });
  });

  it('falls back to legacy when the terminals string is not parseable JSON', () => {
    const list = listTerminalConfigs(dir({
      terminals: 'this is not json',
      terminal_command: '/bin/zsh',
    }));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: DEFAULT_TERMINAL_ID, command: '/bin/zsh' });
  });

  it('findTerminalConfig returns null for unknown ids', () => {
    const d = dir({ terminals: [{ id: DEFAULT_TERMINAL_ID, command: '/bin/sh' }] });
    expect(findTerminalConfig(d, DEFAULT_TERMINAL_ID)).not.toBeNull();
    expect(findTerminalConfig(d, 'no-such-id')).toBeNull();
  });
});

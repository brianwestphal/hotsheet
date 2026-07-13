// HS-9341 — Hot Sheet's managed opencode `permission: ask` config.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureOpencodeAcpConfig, OPENCODE_ACP_CONFIG_NAME, opencodeAcpConfigContent } from './opencodeConfig.js';

describe('opencodeAcpConfigContent (HS-9341)', () => {
  it('asks for permission on edit/bash/webfetch', () => {
    const cfg = JSON.parse(opencodeAcpConfigContent()) as { permission: Record<string, string> };
    expect(cfg.permission).toEqual({ edit: 'ask', bash: 'ask', webfetch: 'ask' });
  });
});

describe('ensureOpencodeAcpConfig (HS-9341)', () => {
  let dataDir: string;
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'hs-occfg-')); });
  afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

  it('writes the managed config under dataDir and returns its path', () => {
    const p = ensureOpencodeAcpConfig(dataDir);
    expect(p).toBe(join(dataDir, OPENCODE_ACP_CONFIG_NAME));
    const cfg = JSON.parse(readFileSync(p, 'utf-8')) as { permission: { edit: string } };
    expect(cfg.permission.edit).toBe('ask');
  });

  it('rewrites a STALE managed config back to the ask defaults', () => {
    const p = join(dataDir, OPENCODE_ACP_CONFIG_NAME);
    writeFileSync(p, JSON.stringify({ permission: { edit: 'allow' } })); // drifted
    ensureOpencodeAcpConfig(dataDir);
    expect((JSON.parse(readFileSync(p, 'utf-8')) as { permission: { edit: string } }).permission.edit).toBe('ask');
  });

  it('is idempotent — a second call leaves the current content intact', () => {
    const p = ensureOpencodeAcpConfig(dataDir);
    const first = readFileSync(p, 'utf-8');
    ensureOpencodeAcpConfig(dataDir); // exercises the "already current" no-write branch
    expect(readFileSync(p, 'utf-8')).toBe(first);
  });
});

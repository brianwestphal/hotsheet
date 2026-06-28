/**
 * `compareVersions` — the gate behind the npm→Tauri update nudge (an update is
 * offered only when current is older than latest). HS-9133 adds coverage for the
 * `checkForUpdates` orchestration (registry fetch + first-use-per-day gate +
 * upgrade box), mocking `https.get` + the data dir.
 */
import { EventEmitter } from 'events';
import { mkdirSync,mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkForUpdates, compareVersions } from './update-check.js';

const h = vi.hoisted(() => ({ dataDir: '', getMock: vi.fn(), statusCode: 200, body: '' }));
vi.mock('https', () => ({ get: h.getMock }));
vi.mock('./global-dir.js', () => ({ globalHotsheetDir: () => h.dataDir }));

describe('compareVersions', () => {
  it('returns 0 for equal versions', () => { expect(compareVersions('1.2.3', '1.2.3')).toBe(0); });
  it('returns -1 when current is older (an update is available)', () => {
    expect(compareVersions('1.2.3', '1.2.4')).toBe(-1);
    expect(compareVersions('1.2.3', '1.3.0')).toBe(-1);
    expect(compareVersions('1.2.3', '2.0.0')).toBe(-1);
  });
  it('returns 1 when current is newer', () => {
    expect(compareVersions('1.2.4', '1.2.3')).toBe(1);
    expect(compareVersions('2.0.0', '1.9.9')).toBe(1);
  });
  it('compares numerically, not lexically (10 > 9)', () => {
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('0.9.0', '0.10.0')).toBe(-1);
  });
  it('treats missing trailing components as 0', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0);
    expect(compareVersions('1.2', '1.2.1')).toBe(-1);
  });
  it('parses a non-numeric component to 0 (so 1.2.3-beta sorts as 1.2.0, below 1.2.3)', () => {
    expect(compareVersions('1.2.3-beta', '1.2.3')).toBe(-1);
    expect(compareVersions('1.2.3-beta', '1.2.0')).toBe(0);
  });
  it('only considers the first three components', () => { expect(compareVersions('1.2.3.9', '1.2.3.1')).toBe(0); });
});

describe('checkForUpdates', () => {
  const logs: string[] = [];
  beforeEach(() => {
    logs.length = 0;
    h.dataDir = mkdtempSync(join(tmpdir(), 'hs-upd-'));
    h.statusCode = 200;
    h.body = '';
    h.getMock.mockReset().mockImplementation((_url: string, _opts: unknown, cb: (res: EventEmitter & { statusCode: number }) => void) => {
      const res = Object.assign(new EventEmitter(), { statusCode: h.statusCode });
      cb(res);
      setImmediate(() => {
        if (h.statusCode === 200) res.emit('data', Buffer.from(h.body));
        res.emit('end');
      });
      return { on: () => ({ on: () => undefined }), destroy: () => undefined };
    });
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(h.dataDir, { recursive: true, force: true }); });

  const logged = (needle: string): boolean => logs.some(l => l.includes(needle));

  it('shows the upgrade box when a newer version is available (force)', async () => {
    h.body = JSON.stringify({ version: '99.0.0' });
    await checkForUpdates(true);
    expect(logged('Update available')).toBe(true);
    // The check date was recorded.
    expect(readFileSync(join(h.dataDir, 'last-update-check'), 'utf-8')).toBe(new Date().toISOString().slice(0, 10));
  });

  it('shows nothing when the latest is not newer', async () => {
    h.body = JSON.stringify({ version: '0.0.1' });
    await checkForUpdates(true);
    expect(logged('Update available')).toBe(false);
  });

  it('shows nothing when the registry fetch fails', async () => {
    h.statusCode = 500;
    await checkForUpdates(true);
    expect(logged('Update available')).toBe(false);
  });

  it('skips the network entirely when already checked today and not forced', async () => {
    mkdirSync(h.dataDir, { recursive: true });
    writeFileSync(join(h.dataDir, 'last-update-check'), new Date().toISOString().slice(0, 10), 'utf-8');
    await checkForUpdates(false);
    expect(h.getMock).not.toHaveBeenCalled();
  });

  it('checks the network on first use of the day (not forced)', async () => {
    h.body = JSON.stringify({ version: '0.0.1' });
    await checkForUpdates(false);
    expect(h.getMock).toHaveBeenCalledTimes(1);
  });
});

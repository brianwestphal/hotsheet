import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CHANNEL_LOG_MAX_BYTES, createChannelLogger } from './channelLog.js';

// HS-8447 follow-up — diagnostic logger for unexpected channel-server
// disconnects. The contract this test pins:
//
//  - every event is appended as a single line ending in `\n` with the
//    fixed `[<iso>] [pid <pid>] event: details` shape;
//  - the file is rotated to `<path>.old` once it exceeds 1 MiB on the
//    next write;
//  - the first write of a process injects a blank separator line
//    before its event IF the file already has prior-process content,
//    so successive lifetimes are visually separated;
//  - filesystem failures are swallowed — the caller must never crash
//    because the log path is unwritable or the parent dir is missing.

describe('channelLog — append-only diagnostic logger (HS-8447 follow-up)', () => {
  let dir: string;
  let logPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hotsheet-channellog-'));
    logPath = join(dir, 'mcp.log');
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes a single line per event with the expected prefix shape', () => {
    const logger = createChannelLogger(logPath);
    logger.log('process-start', 'argv=foo');
    const text = readFileSync(logPath, 'utf-8');
    const lines = text.split('\n').filter(l => l !== '');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[pid \d+\] process-start: argv=foo$/);
  });

  it('omits the details suffix when no details are passed', () => {
    const logger = createChannelLogger(logPath);
    logger.log('heartbeat');
    const text = readFileSync(logPath, 'utf-8');
    expect(text).toMatch(/heartbeat:\n$/);
  });

  it('appends, not overwrites, across multiple calls within one process', () => {
    const logger = createChannelLogger(logPath);
    logger.log('a');
    logger.log('b');
    logger.log('c');
    const lines = readFileSync(logPath, 'utf-8').split('\n').filter(l => l !== '');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(' a:');
    expect(lines[1]).toContain(' b:');
    expect(lines[2]).toContain(' c:');
  });

  it('injects a blank separator line on the first write when the file already has content', () => {
    // Simulate a prior process having written one line into the log.
    writeFileSync(logPath, '[2026-05-01T00:00:00.000Z] [pid 1] prior-run: foo\n', 'utf-8');
    const logger = createChannelLogger(logPath);
    logger.log('process-start', 'this is a fresh lifetime');
    const text = readFileSync(logPath, 'utf-8');
    // Expect exactly one blank line between the prior entry and the new one.
    const lines = text.split('\n');
    expect(lines[0]).toContain('prior-run: foo');
    expect(lines[1]).toBe('');
    expect(lines[2]).toMatch(/process-start: this is a fresh lifetime$/);
  });

  it('does NOT prepend a blank line when the file is fresh (size 0)', () => {
    const logger = createChannelLogger(logPath);
    logger.log('process-start');
    const text = readFileSync(logPath, 'utf-8');
    expect(text.startsWith('\n')).toBe(false);
    expect(text.startsWith('[')).toBe(true);
  });

  it('rotates to <path>.old when the active file would exceed 1 MiB', () => {
    // Pre-seed a file at the size threshold so the next append triggers rotation.
    const seed = 'x'.repeat(CHANNEL_LOG_MAX_BYTES);
    writeFileSync(logPath, seed, 'utf-8');
    expect(statSync(logPath).size).toBe(CHANNEL_LOG_MAX_BYTES);
    const logger = createChannelLogger(logPath);
    logger.log('after-rotation');
    // Active file now holds only the new entry.
    const text = readFileSync(logPath, 'utf-8');
    expect(text).toContain('after-rotation:');
    expect(text.length).toBeLessThan(1024);
    // Prior content was moved to `.old`.
    expect(existsSync(`${logPath}.old`)).toBe(true);
    expect(readFileSync(`${logPath}.old`, 'utf-8')).toBe(seed);
  });

  it('overwrites a prior `.old` rotation slot rather than accumulating numbered backups', () => {
    writeFileSync(`${logPath}.old`, 'ancient', 'utf-8');
    const seed = 'y'.repeat(CHANNEL_LOG_MAX_BYTES);
    writeFileSync(logPath, seed, 'utf-8');
    const logger = createChannelLogger(logPath);
    logger.log('rotation-2');
    expect(readFileSync(`${logPath}.old`, 'utf-8')).toBe(seed);
    expect(existsSync(`${logPath}.old.old`)).toBe(false);
  });

  it('swallows write failures so the caller never crashes', () => {
    // Point at a path whose parent dir does not exist — appendFileSync
    // would throw ENOENT. The logger must not propagate that.
    const bogus = join(dir, 'no-such-subdir', 'mcp.log');
    const logger = createChannelLogger(bogus);
    expect(() => logger.log('event-into-the-void')).not.toThrow();
  });
});

import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { maybeUnlinkPortFile, readChannelInfo, writeChannelInfo } from './channelPortFile.js';

// HS-8452 + HS-8454 — port-aware unlink + the richer port-file format
// (JSON `{port, pid, slug, startedAt}`). Pins both the back-compat read
// path AND the new ownership-aware unlink semantics.

describe('readChannelInfo (HS-8454)', () => {
  let dir: string;
  let portFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hotsheet-portinfo-'));
    portFile = join(dir, 'channel-port');
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('parses the new JSON shape with full identity fields', () => {
    writeFileSync(portFile, JSON.stringify({ port: 56721, pid: 12964, slug: 'hotsheet', startedAt: '2026-05-19T02:09:18.399Z' }), 'utf-8');
    const info = readChannelInfo(portFile);
    expect(info).toEqual({ port: 56721, pid: 12964, slug: 'hotsheet', startedAt: '2026-05-19T02:09:18.399Z' });
  });

  it('accepts the legacy bare-number format and returns pid/slug/startedAt as null', () => {
    writeFileSync(portFile, '59590', 'utf-8');
    expect(readChannelInfo(portFile)).toEqual({ port: 59590, pid: null, slug: null, startedAt: null });
  });

  it('tolerates trailing whitespace in legacy files', () => {
    writeFileSync(portFile, '59590\n', 'utf-8');
    expect(readChannelInfo(portFile)?.port).toBe(59590);
  });

  it('returns null for a missing file', () => {
    expect(readChannelInfo(portFile)).toBeNull();
  });

  it('returns null for an empty file', () => {
    writeFileSync(portFile, '', 'utf-8');
    expect(readChannelInfo(portFile)).toBeNull();
  });

  it('returns null for unparseable JSON', () => {
    writeFileSync(portFile, '{not json', 'utf-8');
    expect(readChannelInfo(portFile)).toBeNull();
  });

  it('returns null when JSON lacks a numeric port', () => {
    writeFileSync(portFile, JSON.stringify({ pid: 1, slug: 'x' }), 'utf-8');
    expect(readChannelInfo(portFile)).toBeNull();
  });

  it('treats missing pid as null (partially-populated payload, e.g. older intermediate format)', () => {
    writeFileSync(portFile, JSON.stringify({ port: 56721 }), 'utf-8');
    expect(readChannelInfo(portFile)).toEqual({ port: 56721, pid: null, slug: null, startedAt: null });
  });
});

describe('writeChannelInfo (HS-8454)', () => {
  let dir: string;
  let portFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hotsheet-portinfo-'));
    portFile = join(dir, 'channel-port');
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('writes the JSON shape that readChannelInfo can round-trip', () => {
    const info = { port: 56721, pid: 12964, slug: 'hotsheet', startedAt: '2026-05-19T02:09:18.399Z' };
    writeChannelInfo(portFile, info);
    expect(readChannelInfo(portFile)).toEqual(info);
  });

  it('overwrites a prior port file atomically (no leftover tmp file)', () => {
    writeFileSync(portFile, '11111', 'utf-8');
    writeChannelInfo(portFile, { port: 22222, pid: 99, slug: 's', startedAt: 't' });
    expect(readChannelInfo(portFile)?.port).toBe(22222);
    // tmp file name uses our pid; ensure it was cleaned up via rename.
    const tmp = `${portFile}.tmp.${process.pid.toString(36)}`;
    expect(existsSync(tmp)).toBe(false);
  });
});

describe('maybeUnlinkPortFile (HS-8452 + HS-8454)', () => {
  let dir: string;
  let portFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hotsheet-portfile-'));
    portFile = join(dir, 'channel-port');
  });

  afterEach(() => {
    try { chmodSync(dir, 0o700); } catch { /* ignore */ }
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // --- New JSON shape: pid is the authoritative ownership signal. ---

  it('unlinks when the JSON file pid matches our pid', () => {
    writeChannelInfo(portFile, { port: 56721, pid: 12964, slug: 'x', startedAt: 't' });
    expect(maybeUnlinkPortFile(portFile, 56721, 12964)).toBe(true);
    expect(existsSync(portFile)).toBe(false);
  });

  it('leaves the JSON file alone when the pid differs (sibling process owns the registration)', () => {
    writeChannelInfo(portFile, { port: 59590, pid: 83798, slug: 'x', startedAt: 't' });
    // We are pid 12964 — different process; even if our port collides with
    // the on-disk port, the pid mismatch is the deciding signal.
    expect(maybeUnlinkPortFile(portFile, 59590, 12964)).toBe(false);
    expect(existsSync(portFile)).toBe(true);
  });

  it('pid mismatch wins even when the port collides (closes the captured HS-8452 trace)', () => {
    // The exact sequence from the captured `mcp.log` trace: pid 83798
    // overwrites the port file with its own port, then runs cleanup. With
    // ONLY a port check, this would unlink (pid 83798's port matches the
    // file's port). With the pid check, the file's pid IS 83798 — so
    // the cleanup correctly unlinks IF we ARE 83798. The protection that
    // matters is for the OPPOSITE case (we're pid A, the file was just
    // overwritten by pid B, our cleanup runs); pinned in the previous case.
    writeChannelInfo(portFile, { port: 59590, pid: 83798, slug: 'x', startedAt: 't' });
    expect(maybeUnlinkPortFile(portFile, 59590, 83798)).toBe(true);
    expect(existsSync(portFile)).toBe(false);
  });

  // --- Legacy bare-port shape: fall back to port equality. ---

  it('unlinks a legacy bare-port file when its port matches our port', () => {
    writeFileSync(portFile, '56721', 'utf-8');
    expect(maybeUnlinkPortFile(portFile, 56721)).toBe(true);
    expect(existsSync(portFile)).toBe(false);
  });

  it('leaves a legacy bare-port file alone when its port differs', () => {
    writeFileSync(portFile, '59590', 'utf-8');
    expect(maybeUnlinkPortFile(portFile, 56721)).toBe(false);
    expect(existsSync(portFile)).toBe(true);
  });

  it('tolerates trailing whitespace in legacy files', () => {
    writeFileSync(portFile, '56721\n', 'utf-8');
    expect(maybeUnlinkPortFile(portFile, 56721)).toBe(true);
  });

  // --- Robustness ---

  it('returns false without throwing when the port file is missing', () => {
    expect(existsSync(portFile)).toBe(false);
    expect(maybeUnlinkPortFile(portFile, 56721)).toBe(false);
  });

  it('returns false for unparseable contents', () => {
    writeFileSync(portFile, '{not json', 'utf-8');
    expect(maybeUnlinkPortFile(portFile, 56721)).toBe(false);
    // File is left alone — caller can decide what to do with garbage.
    expect(existsSync(portFile)).toBe(true);
  });
});

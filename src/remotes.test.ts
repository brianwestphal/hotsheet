// HS-9302 — the machine-global remotes store (~/.hotsheet/remotes.json).
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { tmpdir } = os;
const tempHome = join(tmpdir(), `hs-remotes-test-${Date.now()}`);
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tempHome };
});

const { readRemotes, writeRemotes } = await import('./remotes.js');
const remotesPath = join(tempHome, '.hotsheet', 'remotes.json');

beforeEach(() => {
  try { rmSync(join(tempHome, '.hotsheet'), { recursive: true, force: true }); } catch { /* ignore */ }
});
afterAll(() => {
  try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('readRemotes', () => {
  it('returns an empty store when the file does not exist', () => {
    expect(readRemotes()).toEqual({ servers: [] });
  });

  it('returns an empty store on invalid JSON', () => {
    mkdirSync(join(tempHome, '.hotsheet'), { recursive: true });
    writeFileSync(remotesPath, 'not json');
    expect(readRemotes()).toEqual({ servers: [] });
  });

  it('returns an empty store when the shape is invalid', () => {
    mkdirSync(join(tempHome, '.hotsheet'), { recursive: true });
    writeFileSync(remotesPath, JSON.stringify({ servers: [{ origin: 123 }] })); // origin must be a string
    expect(readRemotes()).toEqual({ servers: [] });
  });
});

describe('writeRemotes → readRemotes round-trip', () => {
  it('persists servers + projects and reads them back', () => {
    const store = {
      servers: [{
        origin: 'https://remote.example:4174',
        label: 'Home server',
        deviceClientId: 'client-abc',
        projects: [{ secret: 'sec-1', name: 'Alpha' }, { secret: 'sec-2', name: 'Beta' }],
      }],
    };
    const written = writeRemotes(store);
    expect(written).toEqual(store);
    expect(readRemotes()).toEqual(store);
  });

  it('normalizes optional fields (label default, projects default)', () => {
    const written = writeRemotes({ servers: [{ origin: 'https://h:4174', label: '', projects: [] }] });
    // label defaults to '' and projects to [] via the schema.
    expect(written.servers[0]).toMatchObject({ origin: 'https://h:4174', label: '', projects: [] });
    expect(readRemotes().servers).toHaveLength(1);
  });

  it('a later write replaces the whole store', () => {
    writeRemotes({ servers: [{ origin: 'https://a:4174', label: 'A', projects: [] }] });
    writeRemotes({ servers: [{ origin: 'https://b:4174', label: 'B', projects: [] }] });
    const back = readRemotes();
    expect(back.servers).toHaveLength(1);
    expect(back.servers[0].origin).toBe('https://b:4174');
  });
});

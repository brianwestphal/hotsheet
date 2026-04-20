import { rmSync } from 'fs';
import * as os from 'os';
import { join, resolve } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { tmpdir } = os;

const tempHome = join(tmpdir(), `hs-project-list-test-${Date.now()}`);
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof os>();
  return { ...actual, homedir: () => tempHome };
});

const { readProjectList, addToProjectList, reorderProjectList, removeFromProjectList } = await import('./project-list.js');

beforeEach(() => {
  try { rmSync(join(tempHome, '.hotsheet'), { recursive: true, force: true }); } catch { /* ignore */ }
});

afterAll(() => {
  try { rmSync(tempHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('readProjectList', () => {
  it('returns [] when file does not exist', () => {
    expect(readProjectList()).toEqual([]);
  });
});

describe('addToProjectList', () => {
  it('adds a project to the list', () => {
    addToProjectList('/projects/alpha');
    const list = readProjectList();
    expect(list).toEqual([resolve('/projects/alpha')]);
  });

  it('does not duplicate existing entries', () => {
    addToProjectList('/projects/alpha');
    addToProjectList('/projects/alpha');
    const list = readProjectList();
    expect(list).toEqual([resolve('/projects/alpha')]);
  });

  it('adds multiple distinct projects', () => {
    addToProjectList('/projects/alpha');
    addToProjectList('/projects/beta');
    const list = readProjectList();
    expect(list).toEqual([resolve('/projects/alpha'), resolve('/projects/beta')]);
  });
});

describe('reorderProjectList', () => {
  it('replaces the list with the given order', () => {
    addToProjectList('/projects/alpha');
    addToProjectList('/projects/beta');
    addToProjectList('/projects/gamma');

    reorderProjectList(['/projects/gamma', '/projects/alpha', '/projects/beta']);
    const list = readProjectList();
    expect(list).toEqual([
      resolve('/projects/gamma'),
      resolve('/projects/alpha'),
      resolve('/projects/beta'),
    ]);
  });
});

describe('removeFromProjectList', () => {
  it('removes a project from the list', () => {
    addToProjectList('/projects/alpha');
    addToProjectList('/projects/beta');
    removeFromProjectList('/projects/alpha');
    const list = readProjectList();
    expect(list).toEqual([resolve('/projects/beta')]);
  });
});

// @vitest-environment happy-dom
/**
 * HS-8858 / HS-8857 — shared copy/paste-settings clipboard helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { copyJsonToClipboard, newEntriesById, parsePastedEntries, readClipboardJsonOrPrompt } from './settingsClipboard.js';
import { showToast } from './toast.js';

// vitest hoists `vi.mock` above the imports, so `showToast` resolves to this stub.
vi.mock('./toast.js', () => ({ showToast: vi.fn() }));

const arrayGuard = (v: unknown): Array<{ id: string }> | null =>
  Array.isArray(v) && v.every(e => typeof e === 'object' && e !== null && typeof (e as { id?: unknown }).id === 'string')
    ? v as Array<{ id: string }>
    : null;

describe('newEntriesById (HS-8858)', () => {
  const idOf = (e: { id: string }) => e.id;
  it('returns only incoming entries whose id is not already present', () => {
    const existing = [{ id: 'a' }, { id: 'b' }];
    const incoming = [{ id: 'b' }, { id: 'c' }, { id: 'd' }];
    expect(newEntriesById(existing, incoming, idOf)).toEqual([{ id: 'c' }, { id: 'd' }]);
  });
  it('returns [] when every incoming id already exists', () => {
    expect(newEntriesById([{ id: 'a' }], [{ id: 'a' }], idOf)).toEqual([]);
  });
  it('returns all incoming when existing is empty', () => {
    expect(newEntriesById([], [{ id: 'x' }], idOf)).toEqual([{ id: 'x' }]);
  });
});

describe('parsePastedEntries (HS-8858)', () => {
  beforeEach(() => vi.clearAllMocks());
  it('returns the validated array for good JSON', () => {
    expect(parsePastedEntries('[{"id":"a"}]', 'auto-context', arrayGuard)).toEqual([{ id: 'a' }]);
    expect(showToast).not.toHaveBeenCalled();
  });
  it('returns null + toasts on non-JSON', () => {
    expect(parsePastedEntries('not json', 'auto-context', arrayGuard)).toBeNull();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("isn't valid JSON"), expect.anything());
  });
  it('returns null + toasts when the shape fails validation', () => {
    expect(parsePastedEntries('{"nope":1}', 'auto-context', arrayGuard)).toBeNull();
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("isn't valid auto-context"), expect.anything());
  });
});

describe('copyJsonToClipboard (HS-8858)', () => {
  beforeEach(() => vi.clearAllMocks());
  it('writes pretty-printed JSON to the clipboard + toasts success', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    await copyJsonToClipboard([{ id: 'a' }], 'Auto-context settings');
    expect(writeText).toHaveBeenCalledWith(JSON.stringify([{ id: 'a' }], null, 2));
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining('copied'), { variant: 'success' });
  });
  it('toasts a warning when the clipboard write rejects', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: () => Promise.reject(new Error('denied')) } });
    await copyJsonToClipboard([], 'Auto-context settings');
    expect(showToast).toHaveBeenCalledWith(expect.stringContaining("Couldn't copy"), { variant: 'warning' });
  });
});

describe('readClipboardJsonOrPrompt (HS-8858)', () => {
  afterEach(() => { document.body.innerHTML = ''; vi.clearAllMocks(); });

  it('returns the clipboard text directly when readText succeeds', async () => {
    vi.stubGlobal('navigator', { clipboard: { readText: () => Promise.resolve('[{"id":"a"}]') } });
    expect(await readClipboardJsonOrPrompt('Paste settings')).toBe('[{"id":"a"}]');
    expect(document.querySelector('.settings-paste-textarea')).toBeNull(); // no overlay needed
  });

  it('falls back to the textarea overlay when readText rejects, resolving the pasted text on Import', async () => {
    vi.stubGlobal('navigator', { clipboard: { readText: () => Promise.reject(new Error('blocked')) } });
    const p = readClipboardJsonOrPrompt('Paste settings');
    await Promise.resolve(); // let the rejected readText settle → overlay mounts
    const textarea = document.querySelector<HTMLTextAreaElement>('.settings-paste-textarea');
    expect(textarea).not.toBeNull();
    textarea!.value = '[{"id":"b"}]';
    document.querySelector<HTMLButtonElement>('.settings-paste-import')!.click();
    expect(await p).toBe('[{"id":"b"}]');
  });

  it('overlay Cancel resolves null (and empty text imports as null)', async () => {
    vi.stubGlobal('navigator', { clipboard: { readText: () => Promise.reject(new Error('blocked')) } });
    const p = readClipboardJsonOrPrompt('Paste settings');
    await Promise.resolve();
    document.querySelector<HTMLButtonElement>('.settings-paste-cancel')!.click();
    expect(await p).toBeNull();
  });
});

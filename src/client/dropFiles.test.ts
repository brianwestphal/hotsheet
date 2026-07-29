/**
 * HS-9465 — a macOS screen capture dragged from the corner preview is a PROMISED
 * file: it has a name, a type and a plausible size, but no backing store yet. The
 * only way to tell is to read it, and the old code found out inside `fetch`, after
 * the multipart headers were already sent — producing a truncated body, a
 * `400 Malformed upload body`, and (because the drop listener had no `catch`) the
 * generic "Something went wrong" crash popup.
 */
import { describe, expect, it } from 'vitest';

import { describeUnreadableDrop, screenDroppedFiles } from './dropFiles.js';

/** A file whose bytes are genuinely there. */
function realFile(name: string, body = 'png-bytes'): File {
  return new File([body], name, { type: 'image/png' });
}

/**
 * The promised-file shape: non-zero `size` (so a size check alone would pass it),
 * but reading throws. This is what the browser hands us for an unsaved capture.
 */
function promisedFile(name: string): File {
  const f = realFile(name);
  Object.defineProperty(f, 'size', { value: 12345 });
  Object.defineProperty(f, 'slice', {
    value: () => ({ arrayBuffer: () => Promise.reject(new Error('NotFoundError: file not found')) }),
  });
  return f;
}

describe('screenDroppedFiles (HS-9465)', () => {
  it('accepts a file whose bytes are actually there', async () => {
    const { readable, unreadable } = await screenDroppedFiles([realFile('shot.png')]);
    expect(readable.map((f) => f.name)).toEqual(['shot.png']);
    expect(unreadable).toEqual([]);
  });

  it('rejects a promised file even though its size looks fine', async () => {
    // The whole point: `size` is a lie here, so only a read tells the truth.
    const file = promisedFile('Screenshot 2026-07-29 at 7.58.03 AM.png');
    expect(file.size).toBeGreaterThan(0);
    const { readable, unreadable } = await screenDroppedFiles([file]);
    expect(readable).toEqual([]);
    expect(unreadable).toEqual(['Screenshot 2026-07-29 at 7.58.03 AM.png']);
  });

  it('rejects a zero-byte file', async () => {
    // The other shape the un-materialized case takes, and never what the user meant.
    const { readable, unreadable } = await screenDroppedFiles([new File([], 'empty.png')]);
    expect(readable).toEqual([]);
    expect(unreadable).toEqual(['empty.png']);
  });

  it('attaches the good files from a mixed drop rather than failing all of them', async () => {
    // Dragging a saved capture together with an unsaved one should still attach
    // the saved one — partial success beats an all-or-nothing failure.
    const { readable, unreadable } = await screenDroppedFiles([
      realFile('saved.png'),
      promisedFile('unsaved.png'),
      realFile('also-saved.png'),
    ]);
    expect(readable.map((f) => f.name)).toEqual(['saved.png', 'also-saved.png']);
    expect(unreadable).toEqual(['unsaved.png']);
  });

  it('names an unnamed file rather than producing an empty quote', async () => {
    const { unreadable } = await screenDroppedFiles([new File([], '')]);
    expect(unreadable).toEqual(['(unnamed file)']);
  });

  it('handles an empty drop', async () => {
    expect(await screenDroppedFiles([])).toEqual({ readable: [], unreadable: [] });
  });

  it('does not consume the file — it stays uploadable', async () => {
    // A full `arrayBuffer()` read would work too, but would buffer a large
    // attachment into memory; slicing one byte must leave the File intact.
    const file = realFile('shot.png', 'the-real-bytes');
    const { readable } = await screenDroppedFiles([file]);
    expect(await readable[0].text()).toBe('the-real-bytes');
  });
});

describe('describeUnreadableDrop (HS-9465)', () => {
  it('names the file and both things that actually work', () => {
    const msg = describeUnreadableDrop(['shot.png']);
    expect(msg).toContain('shot.png');
    // The two recoveries are not guessable, so the message must state them.
    expect(msg).toMatch(/wait for it to appear on your desktop/i);
    expect(msg).toMatch(/⌘V/);
  });

  it('reads correctly for several files', () => {
    const msg = describeUnreadableDrop(['a.png', 'b.png']);
    expect(msg).toContain('2 files');
    expect(msg).toContain('a.png, b.png');
  });

  it('is empty when nothing was skipped', () => {
    expect(describeUnreadableDrop([])).toBe('');
  });
});

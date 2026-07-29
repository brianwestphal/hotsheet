/**
 * HS-9465 — screen a drag-and-drop's files for readable BYTES before uploading.
 *
 * On macOS a fresh screen capture floats in the corner for a few seconds before it is
 * written to disk. It can be dragged during that window, but what the drag carries is a
 * *promise* of a file, not a file — the browser hands us a `File` whose backing store
 * does not exist yet.
 *
 * Nothing about that `File` looks wrong: it has a name, a type, often a plausible size.
 * The failure only appears when something tries to READ it. `fetch` discovers it
 * mid-flight, after the multipart headers are already on the wire, so it sends a
 * TRUNCATED body — which the server can only answer with
 * `400 Malformed upload body` (`routes/attachments.ts`, HS-9227). The drop handler had
 * no `catch`, so that rejection escaped as an unhandled promise rejection and the user
 * got the generic HS-9455 "Something went wrong" crash popup, naming neither the file
 * nor anything they could do about it.
 *
 * So: read one byte first. A file whose bytes are genuinely there survives it cheaply
 * (no full read, no memory spike on a large attachment — that is why this slices rather
 * than calling `arrayBuffer()`), and a promised file fails it *before* any request
 * exists to be truncated. Empty files count as unreadable too: a 0-byte drop is never
 * what the user meant, and it is the other shape the un-materialized case takes.
 */

/** One byte is enough — we only need to know whether the backing store answers. */
async function isReadable(file: File): Promise<boolean> {
  if (file.size === 0) return false;
  try {
    await file.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

export interface ScreenedFiles {
  /** Files whose bytes are actually there — safe to upload. */
  readable: File[];
  /** Names of files that could not be read, for the message to the user. */
  unreadable: string[];
}

/**
 * Split dropped files into the ones we can upload and the ones we can't.
 *
 * Partial success is deliberate: dragging a saved screenshot and an unsaved one together
 * should attach the saved one rather than fail the whole drop.
 */
export async function screenDroppedFiles(files: readonly File[]): Promise<ScreenedFiles> {
  const readable: File[] = [];
  const unreadable: string[] = [];
  for (const file of files) {
    if (await isReadable(file)) readable.push(file);
    else unreadable.push(file.name === '' ? '(unnamed file)' : file.name);
  }
  return { readable, unreadable };
}

/**
 * What to tell the user about files we couldn't read.
 *
 * Names the macOS case explicitly, because "it didn't work" is useless here and the two
 * things that DO work are not guessable: wait for the capture to land on the desktop, or
 * paste it instead (§77 handles clipboard images, and a screenshot taken with
 * Ctrl held goes straight to the clipboard with no file at all).
 *
 * Pure — exported for the unit test.
 */
export function describeUnreadableDrop(names: readonly string[]): string {
  if (names.length === 0) return '';
  const list = names.join(', ');
  const subject = names.length === 1 ? `“${list}” has` : `${String(names.length)} files (${list}) have`;
  return `${subject} no readable content yet. A screen capture can be dragged from the corner preview before macOS has written it to disk — wait for it to appear on your desktop and drag it again, or press ⌘V to paste it directly.`;
}

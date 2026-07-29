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

/**
 * Above this, don't buffer the file into memory — stream it as before.
 *
 * A promised screen capture is a few hundred KB, so the case this whole module
 * exists for is never anywhere near the limit. The cap is only so that dropping a
 * genuinely large attachment (a video) doesn't double its memory.
 */
const MAX_MATERIALIZE_BYTES = 64 * 1024 * 1024;

/**
 * Turn a dropped file into one whose bytes we HOLD, or null if they aren't there.
 *
 * The first version of this only checked that reading one byte didn't throw, and
 * it was not enough — the reported failure got past it and still produced
 * `Malformed upload body`. Two ways that check was too weak:
 *
 *  1. `slice(0, 1).arrayBuffer()` can RESOLVE WITH ZERO BYTES. No throw, nothing
 *     read, and the file sails through as readable.
 *  2. Even a genuinely readable first byte proves nothing about the rest. `fetch`
 *     streams a `File` lazily, so the body can still truncate mid-flight — which
 *     is exactly the failure we were trying to detect, just moved later.
 *
 * So the check is no longer a check. We read the bytes and upload THOSE, which
 * makes truncation structurally impossible: either the promise delivered and we
 * hold a real in-memory file, or it didn't and we say so before any request
 * exists. A short read counts as failure too — a partially-delivered PNG is
 * garbage, and silently attaching it would be worse than refusing.
 */
async function materialize(file: File): Promise<File | null> {
  if (file.size === 0) return null;
  try {
    if (file.size > MAX_MATERIALIZE_BYTES) {
      // Too big to buffer. Verify a byte is genuinely there (with the emptiness
      // check the original version was missing) and stream it as before.
      const probe = await file.slice(0, 1).arrayBuffer();
      return probe.byteLength > 0 ? file : null;
    }
    const bytes = await file.arrayBuffer();
    if (bytes.byteLength === 0) return null;
    // Short read ⇒ the promise did not deliver what it claimed.
    if (file.size > 0 && bytes.byteLength < file.size) return null;
    return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified });
  } catch {
    return null;
  }
}

export interface ScreenedFiles {
  /**
   * Files safe to upload. For anything under `MAX_MATERIALIZE_BYTES` these are
   * IN-MEMORY copies, not the originals — that is the point, since the original
   * may be a promise whose backing store can still vanish mid-upload.
   */
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
    const materialized = await materialize(file);
    if (materialized !== null) readable.push(materialized);
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

/**
 * HS-9466 — describe what a drag actually carried, for the one diagnostic that
 * gates the native work (docs/130 §130.4).
 *
 * We know the `files` entry is a broken promise; what nobody has checked is
 * whether the SAME drag also offers a representation that does carry bytes (an
 * `image/png` item, a resolvable URL). If it does, the fix is a few lines of
 * client code and the Rust/Objective-C path is unjustified. If it comes back with
 * nothing but the promised file, that is the evidence that native is the only way.
 *
 * Logged only on the failure path, so it costs nothing in normal use — and this
 * failure is rare enough, and hard enough to reproduce on demand, that asking a
 * user to reproduce it twice (once to notice, once with instrumentation) is worse
 * than carrying these few lines.
 *
 * Pure: takes only the transfer's shape, returns a string. Exported for the test.
 */
export function describeDragPayload(
  types: readonly string[],
  items: readonly { kind: string; type: string }[],
): string {
  const typeList = types.length > 0 ? types.join(', ') : '(none)';
  const itemList = items.length > 0
    ? items.map((it, i) => `  [${String(i)}] kind=${it.kind || '(empty)'} type=${it.type || '(empty)'}`).join('\n')
    : '  (no items)';
  return `types: ${typeList}\nitems:\n${itemList}`;
}

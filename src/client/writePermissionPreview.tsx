import { toElement } from './dom.js';

/**
 * HS-8296 — Write-tool permission popup body + actions.
 *
 * Replaces the §47 generic flat-JSON / live-terminal-checkout body for
 * any `Write` tool permission with a tool-specific layout:
 *
 *   1. Title (in the dialog shell): `Allow write to <path>?`
 *   2. Body: a scrollable monospaced `<pre>` of the full file content
 *      Claude is about to write (text), OR a `Binary Data (NNN bytes)`
 *      placeholder when the content fails text-decode.
 *   3. Actions: three vertically-stacked buttons (mirroring HS-8299's
 *      Bash button column) —
 *      - "Yes" (primary): allow this single request only
 *      - "Yes, and don't ask again for edits in <dir> during this session":
 *        mirrors Claude's TUI copy verbatim (per the user's HS-8296 Q2 /
 *        Q3 feedback "this is the text copied from Claude itself, just
 *        mirror what Claude says"). v1 ships the UI without persisting
 *        a session-scoped rule — clicking the middle button just
 *        responds `allow`. A follow-up ticket can wire a real session-
 *        bound directory allow-list (the §47.4 rule schema is
 *        path-tool-only and skips Edit / Write deliberately because
 *        file-path alone doesn't capture write intent).
 *      - "No": deny
 *
 * Locked decisions per the user's HS-8296 feedback:
 * - Q1 = "yes" → (a) full content for new files, (b) diff for
 *   overwrites, (c) `Binary Data (NNN bytes)` when content fails
 *   text-decode. v1 ships (a) and (c); (b) requires fetching the
 *   existing file's bytes which we don't have at popup-mount time —
 *   filed as a follow-up.
 * - Q2 / Q3 → mirror Claude's verbatim copy on the middle button. The
 *   technical scope is Write-only for now; the label says "edits" to
 *   match Claude's wording.
 * - Q4 = "replace" → live-terminal checkout is SKIPPED entirely for
 *   Write (the pre-fix `useLiveCheckout` heuristic for non-trivial
 *   previews no longer fires for this tool).
 *
 * Pre-decode heuristic for binary detection: count NUL bytes and
 * non-printable control chars in the first 4 KB of content. \> 1 % of
 * those bytes flips the classification to binary. Conservative — text
 * files with the occasional bell / FF / VT char (e.g. xterm outputs
 * captured to disk) still render as text.
 */

const BINARY_DETECTION_PROBE_BYTES = 4096;
const BINARY_DETECTION_THRESHOLD = 0.01;

/** Pure: classify a content string as binary or text. Exported for unit-test
 *  isolation. */
export function looksLikeBinaryContent(content: string): boolean {
  if (content === '') return false;
  const probe = content.length > BINARY_DETECTION_PROBE_BYTES
    ? content.slice(0, BINARY_DETECTION_PROBE_BYTES)
    : content;
  let nonPrintable = 0;
  for (let i = 0; i < probe.length; i++) {
    const code = probe.charCodeAt(i);
    // NUL is the strongest signal; otherwise C0 control chars excluding
    // tab (0x09), newline (0x0a), and carriage return (0x0d).
    if (code === 0) { nonPrintable++; continue; }
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) {
      nonPrintable++;
    }
  }
  return (nonPrintable / probe.length) > BINARY_DETECTION_THRESHOLD;
}

export interface WritePermissionPreviewParts {
  bodyElement: HTMLElement;
  actionsElement: HTMLElement;
  /** The dialog title to use (e.g. `Allow write to /tmp/.../foo.txt?`).
   *  Computed here so the caller doesn't need to duplicate the path
   *  formatting. */
  title: string;
}

export interface WritePermissionPreviewOptions {
  /** Absolute file path Claude wants to write to (extracted from
   *  `perm.input_preview.file_path`). */
  filePath: string;
  /** The exact bytes Claude wants to write (extracted from
   *  `perm.input_preview.content`). When the content fails the
   *  binary-detection heuristic, the body renders a
   *  `Binary Data (NNN bytes)` placeholder instead of the verbatim
   *  string. */
  content: string;
  /** Fires when the user clicks "Yes". Caller invokes its existing
   *  allow-the-current-request logic. */
  onAllow: () => void;
  /** Fires when the user clicks the middle "Yes, and don't ask again..."
   *  button. v1 just allows the current request — a future ticket can
   *  wire a real session-bound directory allow-list here. */
  onAllowAlways: () => void;
  /** Fires when the user clicks "No". Caller invokes its existing
   *  deny-the-current-request logic. */
  onDeny: () => void;
}

export function buildWritePermissionPreview(opts: WritePermissionPreviewOptions): WritePermissionPreviewParts {
  const isBinary = looksLikeBinaryContent(opts.content);
  const bodyElement = isBinary
    ? toElement(<pre className="permission-write-content permission-write-content-binary">{`Binary Data (${opts.content.length} bytes)`}</pre>)
    : toElement(<pre className="permission-write-content">{opts.content}</pre>);

  // HS-8296 Q2 / Q3 — middle-button label mirrors Claude's verbatim
  // TUI copy. The directory in the label is the parent dir of the
  // file being written.
  const dirName = parentDirOf(opts.filePath);
  const allowAlwaysLabel = `Yes, and don't ask again for edits in ${dirName} during this session`;

  const actionsElement = toElement(
    <div className="permission-popup-actions permission-popup-actions-stacked">
      <button className="btn btn-primary permission-popup-allow" type="button">Yes</button>
      <button className="btn permission-popup-allow-always" type="button">{allowAlwaysLabel}</button>
      <button className="btn permission-popup-deny" type="button">No</button>
    </div>
  );

  const allowBtn = actionsElement.querySelector<HTMLButtonElement>('.permission-popup-allow')!;
  const allowAlwaysBtn = actionsElement.querySelector<HTMLButtonElement>('.permission-popup-allow-always')!;
  const denyBtn = actionsElement.querySelector<HTMLButtonElement>('.permission-popup-deny')!;

  allowBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    opts.onAllow();
  });

  denyBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    opts.onDeny();
  });

  allowAlwaysBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    opts.onAllowAlways();
  });

  return {
    bodyElement,
    actionsElement,
    title: `Allow write to ${opts.filePath}?`,
  };
}

/** Pure: extract the parent directory of an absolute path. Trailing slash
 *  preserved so the label reads as a directory (e.g. `/tmp/foo/`). The
 *  root case (`/foo` → `/`) keeps the slash. */
function parentDirOf(filePath: string): string {
  const lastSlash = filePath.lastIndexOf('/');
  if (lastSlash <= 0) return '/';
  return filePath.slice(0, lastSlash + 1);
}

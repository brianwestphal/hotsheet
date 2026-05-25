/**
 * Pure helpers + types for the permission popup, extracted out of
 * `permissionOverlay.tsx` per HS-8384. Everything here is side-effect-
 * free and DOM-free so unit tests can drive the predicates without
 * bootstrapping the rest of the popup machinery.
 *
 * The popup mount + state machine + polling loop stay in
 * `permissionOverlay.tsx`; that file re-exports the names below so
 * existing `from './permissionOverlay.js'` imports keep their shape.
 */

import type { EditDiffShape } from './permissionPreview.js';

export type PermissionData = { request_id: string; tool_name: string; description: string; input_preview?: string };

/**
 * HS-8217 — single-line flat preview length above which the popup
 * borrows the live terminal instead of rendering a static `<pre>`. Tuned
 * so that short bash one-liners (`ls -la`, `git status`) stay on the
 * tight static path while pipelines / longer commands surface the rich
 * TUI output. 80 chars matches the conventional "fits on one terminal
 * line" cap.
 */
export const LIVE_CHECKOUT_PREVIEW_CHAR_THRESHOLD = 80;

/**
 * HS-8217 — pure heuristic: should the popup borrow the live terminal
 * via §54 checkout instead of rendering a static `<pre>` / DOM diff?
 *
 * Triggers (any one — short-circuit OR):
 *   - **Edit / Write parseable** — `editDiff !== null`. Edit/Write diffs
 *     are inherently multi-line and benefit substantially from the real
 *     claude TUI's colored rendering (file-name header + dim-faded
 *     unchanged context + green added rows + red removed rows + the
 *     numbered choices list directly below) over the static
 *     `renderEditDiffPreview` HTML diff. User report HS-8217: "the text
 *     is hard to follow. in the terminal, the edits are color coded so
 *     it's easier to see what's being added / removed".
 *   - **Truncation** — flat preview ends in `…` (HS-7999) OR
 *     `editDiff.truncated === true` (HS-8139). Pre-HS-8217 these were
 *     the only triggers — the static body would otherwise be
 *     ambiguous.
 *   - **Multi-line flat** — `previewText.includes('\n')` for non-Edit
 *     tools (e.g. WebFetch with a multi-line body, generic key/value
 *     dumps from `formatInputPreview`'s flat fallback).
 *   - **Long single-line flat** — `previewText.length > 80` (the
 *     `LIVE_CHECKOUT_PREVIEW_CHAR_THRESHOLD` constant). Long single-line
 *     bash pipelines benefit from seeing the actual claude prompt's
 *     wrapping + surrounding context.
 *
 * Stays static for: short single-line bash / `git status` / one-line
 * `Read` previews, where the `<pre>` is tight and the live terminal
 * would surround the value with noise that adds no scanning value AND
 * would pay the noSpawn-fallback round-trip if `'default'` isn't live.
 *
 * Pure helper, no DOM / module state. Exported for unit-test isolation.
 */
export function shouldUseLiveCheckout(
  toolName: string,
  editDiff: EditDiffShape | null,
  previewText: string,
): boolean {
  // HS-8582 — Bash NEVER uses the live-terminal body. A Bash permission's
  // relevant content is the command itself, which the caller renders as a
  // `<pre>` via `formatInputPreview` (tolerant of Claude's ~2000-char
  // `input_preview` truncation). The live project terminal doesn't show the
  // command at all. Pre-fix, a LONG bash command whose `input_preview` was
  // truncated mid-JSON made `extractPrimaryValue` (strict `JSON.parse`, no
  // fallback) return null → the custom Bash layout was skipped → the
  // truncated `formatInputPreview` text (ending in `…`) tripped the
  // `endsWith('…')` rule below → Bash dropped into live-checkout and
  // rendered an empty black terminal box (the HS-8582 symptom). Excluding
  // Bash here closes that path regardless of extraction success.
  if (toolName === 'Bash') return false;
  if (editDiff !== null) return true;
  if (previewText === '') return false;
  if (previewText.endsWith('…')) return true;
  if (previewText.includes('\n')) return true;
  if (previewText.length > LIVE_CHECKOUT_PREVIEW_CHAR_THRESHOLD) return true;
  return false;
}

/**
 * HS-8296 — pure: extract `{file_path, content}` from a Write tool's
 * `input_preview` JSON. Returns null when the JSON is malformed, the
 * tool's primary fields are missing, or `file_path` is empty (the
 * dialog title needs a real path to render usefully).
 *
 * Exported for unit-test isolation. The `content` field can legitimately
 * be empty (Claude is asked to create an empty file) — the body
 * renderer handles that case as "0 bytes" text rather than rejecting it.
 */
export function extractWriteFields(inputPreview: string): { filePath: string; content: string } | null {
  if (inputPreview === '') return null;
  let parsed: unknown;
  try { parsed = JSON.parse(inputPreview); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const filePath = obj.file_path;
  const content = obj.content;
  if (typeof filePath !== 'string' || filePath === '') return null;
  if (typeof content !== 'string') return null;
  return { filePath, content };
}

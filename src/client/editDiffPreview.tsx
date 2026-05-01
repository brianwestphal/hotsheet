import { toElement } from './dom.js';
import type { EditDiffShape } from './permissionPreview.js';

/**
 * HS-7951 — inline unified-diff renderer for the Claude permission popup
 * when the tool is `Edit` / `Write`. Replaces the flat-JSON `<pre>` preview
 * (which dumped `old_string` / `new_string` raw, leaving the user to mentally
 * reconstruct the diff) with a colour-coded line-level diff that's actually
 * scannable.
 *
 * See docs/47-richer-permission-overlay.md §47.3 for the design.
 *
 * Pure DOM-mounting helper exported alongside three pure helpers
 * (`splitLines`, `computeDiffOps`, `buildHunks`) so the line-level math is
 * unit-testable without touching the live overlay.
 */

export type DiffOp = { kind: 'ctx' | 'add' | 'del'; text: string };

export interface DiffHunk {
  /** Sequential lines that should render as one visual block. */
  lines: DiffOp[];
}

/**
 * Pure: split a string into "lines" preserving the trailing-newline-or-not
 * distinction we don't actually care about for the visual diff (Edit's
 * `old_string` / `new_string` are both arbitrary substrings, not always
 * line-aligned). We treat empty trailing-newline groups as a single trailing
 * empty line so a one-line replacement at the file's end renders correctly.
 */
export function splitLines(text: string): string[] {
  if (text === '') return [''];
  const lines = text.split('\n');
  // Trailing '\n' produces an empty final element — keep it so the diff
  // visually preserves the trailing newline.
  return lines;
}

/**
 * Pure LCS-based line diff producing a flat sequence of `add` / `del` /
 * `ctx` ops in source order. Standard Myers-style backtrack over a DP table.
 * O(m*n) time + space — fine for our inputs (Edit's `input_preview` capped
 * at ~2000 chars / typically \< 50 lines).
 */
export function computeDiffOps(oldStr: string, newStr: string): DiffOp[] {
  const oldLines = splitLines(oldStr);
  const newLines = splitLines(newStr);
  const m = oldLines.length;
  const n = newLines.length;

  // dp[i][j] = LCS length of oldLines[0..i] vs newLines[0..j].
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  const ops: DiffOp[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      ops.push({ kind: 'ctx', text: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.push({ kind: 'add', text: newLines[j - 1] });
      j--;
    } else {
      ops.push({ kind: 'del', text: oldLines[i - 1] });
      i--;
    }
  }
  return ops.reverse();
}

/**
 * Pure: collapse a flat op list into hunks. Long stretches of unchanged
 * `ctx` ops between changes are trimmed to `contextLines` on either side
 * (default 2 — same as `git diff`'s `-U2`). Adjacent hunks separated by
 * fewer than `2 * contextLines` ctx lines are kept as a single hunk so
 * interleaved changes don't fragment.
 */
export function buildHunks(ops: DiffOp[], contextLines: number = 2): DiffHunk[] {
  if (ops.length === 0) return [];
  const allCtx = ops.every(op => op.kind === 'ctx');
  if (allCtx) return []; // no changes — render nothing

  const hunks: DiffHunk[] = [];
  let currentHunk: DiffOp[] = [];
  // Scan the ops, accumulating into the current hunk. When we see a long
  // stretch of leading / trailing ctx, trim it.
  // Simpler path: walk the ops, find the index ranges of consecutive change
  // runs (add/del), and build hunks around them.
  type Range = { start: number; end: number };
  const changeRanges: Range[] = [];
  let runStart = -1;
  for (let i = 0; i < ops.length; i++) {
    const isChange = ops[i].kind !== 'ctx';
    if (isChange && runStart === -1) runStart = i;
    if (!isChange && runStart !== -1) {
      changeRanges.push({ start: runStart, end: i - 1 });
      runStart = -1;
    }
  }
  if (runStart !== -1) changeRanges.push({ start: runStart, end: ops.length - 1 });

  // Expand each change range with contextLines on either side, then merge
  // overlapping / adjacent expansions.
  const merged: Range[] = [];
  for (const r of changeRanges) {
    const start = Math.max(0, r.start - contextLines);
    const end = Math.min(ops.length - 1, r.end + contextLines);
    // HS-8093 — `Array.prototype.at(-1)` returns `T | undefined` in TS so
    // the defensive `last !== undefined` check is meaningful to lint
    // (whereas `merged[merged.length - 1]` is typed `Range` because the
    // project doesn't enable `noUncheckedIndexedAccess`).
    const last = merged.at(-1);
    if (last !== undefined && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
    } else {
      merged.push({ start, end });
    }
  }

  for (const r of merged) {
    currentHunk = [];
    for (let i = r.start; i <= r.end; i++) currentHunk.push(ops[i]);
    hunks.push({ lines: currentHunk });
  }

  return hunks;
}

/**
 * Render the full diff as a DOM element. The caller embeds this inside the
 * permission popup's body. Layout: optional file-path header, scroll-bounded
 * body (`max-height: 240px`), one diff line per row, optional truncation
 * footer.
 */
export function renderEditDiffPreview(diff: EditDiffShape): HTMLElement {
  const ops = computeDiffOps(diff.oldStr, diff.newStr);
  const hunks = buildHunks(ops);

  const root = toElement(
    <div className="edit-diff-preview">
      {diff.filePath !== null && diff.filePath !== ''
        ? <div className="edit-diff-path">
            {diff.filePath}
            {diff.replaceAll ? <span className="edit-diff-replace-all"> · replace all</span> : null}
          </div>
        : null}
      <div className="edit-diff-body"></div>
    </div>
  );

  const body = root.querySelector('.edit-diff-body')!;
  if (hunks.length === 0) {
    body.appendChild(toElement(
      <div className="edit-diff-empty"><em>(no visible change)</em></div>
    ));
  } else {
    hunks.forEach((hunk, idx) => {
      if (idx > 0) {
        body.appendChild(toElement(<div className="edit-diff-hunk-sep">⋯</div>));
      }
      for (const line of hunk.lines) {
        const gutter = line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' ';
        body.appendChild(toElement(
          <div className={`edit-diff-line edit-diff-${line.kind}`}>
            <span className="edit-diff-gutter">{gutter}</span>
            <span className="edit-diff-text">{line.text === '' ? ' ' : line.text}</span>
          </div>
        ));
      }
    });
  }

  if (diff.truncated) {
    root.appendChild(toElement(<div className="edit-diff-truncated">… (truncated)</div>));
  }

  return root;
}

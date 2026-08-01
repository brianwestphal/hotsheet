/**
 * HS-9543 — no source file may contain a literal NUL byte.
 *
 * ## Why this is a test and not an ESLint rule
 *
 * ESLint sees a parsed program, where a literal NUL inside a template literal is just
 * a character with no syntax to match. The damage is done at the BYTE level, to the
 * tools that read the file as bytes rather than as JavaScript.
 *
 * ## The damage
 *
 * `grep` and `ripgrep` both stop at the first NUL and report `binary file matches`
 * instead of the matching lines. So a single NUL anywhere in a file makes the WHOLE
 * file invisible to code search — silently, and in the worst way: the search returns
 * "no results" rather than an error, so the reader concludes the thing they were
 * looking for does not exist.
 *
 * This was not hypothetical. Four files had picked one up, all using it as a
 * composite-key separator (`${a}\0${b}`):
 *
 *   src/client/noteRenderer.tsx       674 lines, invisible to search
 *   src/diagnostics/freezeAnalysis.ts
 *   src/db/telemetryMigration.ts
 *   src/db/otelRollupBackfill.ts
 *
 * It cost a real detour during HS-9539 — searching `noteRenderer.tsx` for the
 * `marked.parse` call site returned nothing, from a file that plainly contained it.
 *
 * ## The fix is free
 *
 * Write the ESCAPE `\0` instead of the raw byte. It produces the identical string —
 * only the source bytes differ — so a NUL separator remains perfectly fine to use.
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const NUL = 0;
const ROOTS = ['src', 'e2e', 'plugins', 'scripts', 'eslint-rules'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', '.claude', 'coverage', 'test-results']);
const EXTS = ['.ts', '.tsx', '.mjs', '.js', '.scss', '.json', '.md'];

/** Every text-ish file under the source roots. Walked here rather than shelled out to
 *  `find`, so the test works the same on every platform CI runs on. */
function listSourceFiles() {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(dir, e.name));
      } else if (EXTS.some((x) => e.name.endsWith(x))) {
        out.push(join(dir, e.name));
      }
    }
  };
  for (const r of ROOTS) walk(r);
  return out;
}

describe('no literal NUL bytes in source', () => {
  it('every source file is readable as text by grep / ripgrep', () => {
    const offenders = [];
    for (const rel of listSourceFiles()) {
      const buf = readFileSync(rel);
      if (buf.includes(NUL)) {
        const line = buf.subarray(0, buf.indexOf(NUL)).toString('utf8').split('\n').length;
        offenders.push(`${rel}:${String(line)}`);
      }
    }
    expect(
      offenders,
      'A literal NUL byte makes grep/rg treat the WHOLE file as binary, so code search '
      + 'silently returns nothing for it. Write the escape `\\0` instead — identical '
      + 'string, different source bytes. Offenders:\n  ' + offenders.join('\n  '),
    ).toEqual([]);
  });
});

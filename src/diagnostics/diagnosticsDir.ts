/**
 * HS-9531 — where process-wide diagnostics are written.
 *
 * ## Why this exists
 *
 * `freeze.log` used to live at `<dataDir>/freeze.log`, i.e. once per project.
 * The event loop is not per-project — it is one shared resource in one process —
 * so splitting its diagnostics per project is a category error, and it had a
 * measurable cost.
 *
 * The heartbeat (the thing that observes a block) attributes every stall to the
 * FIRST-booted project's dataDir, because a shared loop genuinely cannot be
 * blamed on one project (HS-8674, deliberate). But `instrumentSync` /
 * `instrumentAsync` (the things that name a *cause*) each wrote to their OWN
 * project's file. Effect in one file, causes in nine.
 *
 * Measured over a 3.8 h window with nine projects registered: correlating the
 * heartbeat against only the hotsheet log attributed 139.6 s of blocking and left
 * 255.3 s (65 %) looking like it was caused by nothing instrumented. Merging all
 * nine logs moved that to 272.9 s attributed — two-thirds of the "mystery" was
 * simply in the other eight files. The HS-9521 investigation reached a wrong
 * conclusion from exactly this, and it took a hand-written merge script to see it.
 *
 * So: one process-wide sink, with the originating project recorded ON each entry
 * instead of encoded in which file it landed in. Attribution is preserved and
 * correlation becomes reading one file in timestamp order.
 *
 * ## Why `globalHotsheetDir()` and not a fixed path
 *
 * It honors `HOTSHEET_HOME` (docs/87), which is what keeps the §87 test instance,
 * and the test suite, out of the user's real `~/.hotsheet`. That mattered
 * immediately: nothing set `HOTSHEET_HOME` for unit tests before this change, so
 * routing diagnostics globally without it would have had every `vitest` run
 * appending to the maintainer's live diagnostics file.
 */

import { mkdirSync } from 'fs';
import { basename, dirname, join } from 'path';

import { globalHotsheetDir } from '../global-dir.js';

/** Subdirectory under the global Hot Sheet dir. Keeps diagnostics from mixing
 *  with `config.json` / `projects.json` / the telemetry cluster. */
export const DIAGNOSTICS_SUBDIR = 'diagnostics';

/**
 * The one directory every process-wide diagnostic writes to.
 *
 * Created on demand. `mkdirSync` with `recursive: true` is a no-op when it
 * already exists, so this stays cheap enough to call per append — and calling it
 * per append is what makes the logger survive someone deleting the directory
 * underneath a running server.
 */
export function diagnosticsDir(): string {
  const dir = join(globalHotsheetDir(), DIAGNOSTICS_SUBDIR);
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    // Diagnostics must never break the caller's hot path. A failure here surfaces
    // as an append error, which `appendFreezeLog` already swallows.
  }
  return dir;
}

/**
 * A short, human-readable name for the project a diagnostic came from.
 *
 * This is the provenance that used to be implicit in the file path. Keep it
 * stable and recognizable — it is what a reader groups by.
 *
 *   /Users/x/Documents/kerf/.hotsheet   -> "kerf"
 *   /Users/x/.hotsheet/telemetry        -> "telemetry"
 *
 * `null`/empty yields `"(unknown)"` rather than throwing: an unlabeled entry is
 * far better than a lost one, since the logger runs on paths that are already
 * degraded when they fire.
 */
export function projectLabelForDataDir(dataDir: string | null | undefined): string {
  if (dataDir === null || dataDir === undefined || dataDir.trim() === '') return '(unknown)';
  const normalized = dataDir.replace(/[/\\]+$/, '');
  const base = basename(normalized);
  // A project's dataDir is `<project>/.hotsheet`, so the interesting name is its
  // parent. Anything else (the global telemetry dir, a temp dir in tests) is
  // already named by its own basename.
  if (base === '.hotsheet') {
    const parent = basename(dirname(normalized));
    return parent === '' ? '(unknown)' : parent;
  }
  return base === '' ? '(unknown)' : base;
}

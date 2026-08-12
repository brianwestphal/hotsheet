/**
 * HS-9436 — LOCAL-ONLY live CLI-contract test for the Gemini skills writer
 * (HS-9374, docs/118), against the REAL `gemini` binary (skips unless `gemini`
 * is on PATH). Cost-free: no LLM turn — it generates `.gemini/skills` with the
 * production writer and asks `gemini skills list` to DISCOVER them, all in a
 * throwaway HOME + project so the user's real config is never touched.
 *
 * Why a LIVE test on top of the `src/skills.test.ts` unit tests: those assert
 * the on-disk `.gemini/skills/<name>/SKILL.md` shape, but only the real gemini
 * CLI proves that shape (frontmatter + directory layout) is one it actually
 * discovers. This catches gemini changing its skill-discovery contract before a
 * user hits it. (GEMINI.md — the instruction file — has no CLI list surface, so
 * it stays unit-tested.)
 *
 * Trust note: `gemini skills list` skips project skills in an "untrusted"
 * folder. We disable folder-trust in the throwaway HOME's settings.json
 * (`security.folderTrust.enabled: false`), which makes discovery run
 * non-interactively and needs no auth (skills-list is purely local).
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ensureGeminiSkills } from './skills.js';

vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

function cliPresent(bin: string): boolean {
  try {
    execFileSync(bin, ['--version'], { stdio: 'ignore', timeout: 5000, killSignal: 'SIGKILL' });
    return true;
  } catch {
    return false;
  }
}

const geminiPresent = cliPresent('gemini');

describe.skipIf(!geminiPresent)('gemini skills CLI contract (HS-9436) (skipped: gemini not on PATH)', () => {
  let home: string;
  let project: string;

  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'hs-gemini-home-'));
    project = mkdtempSync(join(tmpdir(), 'hs-gemini-proj-'));
    mkdirSync(join(project, '.hotsheet'), { recursive: true });
    // Disable folder-trust so `skills list` discovers project skills
    // non-interactively (else it prints "Skipping project agents due to
    // untrusted folder" and finds nothing).
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(
      join(home, '.gemini', 'settings.json'),
      JSON.stringify({ security: { folderTrust: { enabled: false } } }),
    );
  });

  afterAll(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(project, { recursive: true, force: true });
  });

  it('the generated .gemini/skills tree is discovered by real `gemini skills list`', () => {
    // Production writer: with no canonical Claude source in this fresh project it
    // seeds full skill bodies (base `hotsheet` + `hotsheet-worker` + per-category
    // `hs-*`).
    expect(ensureGeminiSkills(project, join(project, '.hotsheet'))).toBe(true);

    const out = execFileSync('gemini', ['skills', 'list'], {
      cwd: project,
      encoding: 'utf8',
      timeout: 25_000,
      killSignal: 'SIGKILL',
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });

    // gemini lists each discovered skill by name; the base worklist skill + a
    // ticket-type skill must both appear (proves the frontmatter + layout parse).
    expect(out).toContain('Discovered Agent Skills');
    expect(out).toContain('hotsheet');
    expect(out).toContain('hs-bug');
  });
});

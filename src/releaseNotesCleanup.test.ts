// HS-9628 — release-note markdown headings must survive tagging.
//
// `git tag` defaults to `--cleanup=strip`, which drops every line beginning
// with `#` as a comment. Release notes (hand-drafted or gitgist-generated) use
// `##`/`###` markdown headings for section labels; the GitHub Release body is
// built from the annotated tag's message, so a stripped heading is a lost
// section label in the published notes. Both release scripts must therefore
// pass `--cleanup=verbatim` to every `git tag -a` call.
//
// This suite guards the fix two ways: (1) a static assertion that the flag is
// present on every real `git tag -a` invocation in the scripts, and (2) a
// behavioral demonstration of git's own cleanup semantics — strip drops the
// heading, verbatim keeps it — so the assertion in (1) is grounded in the
// actual git behavior it protects against, not a guess about the default.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Sync child-process calls need both `timeout` and `killSignal: 'SIGKILL'`
// (project rule / ESLint `no-restricted-syntax`) — git never wedges here, but
// the backstop is uniform. `GIT_TERMINAL_PROMPT=0` fails fast rather than
// blocking on a credential prompt; the isolated config env keeps the user's
// global/system git config out of the temp repo.
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};

function git(cwd: string, args: string[], input?: string): string {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf-8',
    timeout: 10000,
    killSignal: 'SIGKILL',
    env: GIT_ENV,
  });
}

describe('release scripts pass --cleanup=verbatim to git tag -a (HS-9628)', () => {
  const scripts = ['scripts/release.sh', 'scripts/release-beta-auto.sh'];

  for (const rel of scripts) {
    it(`${rel}: every real \`git tag -a\` invocation keeps --cleanup=verbatim`, () => {
      const content = readFileSync(join(REPO_ROOT, rel), 'utf-8');
      // Only the executed invocations look like `git tag -a "$..."`; comments
      // in these scripts reference `git tag -d`/prose forms that don't match.
      const tagLines = content
        .split('\n')
        .filter((line) => /\bgit tag -a "/.test(line) && !line.trim().startsWith('#'));

      expect(tagLines.length, `expected at least one \`git tag -a\` call in ${rel}`).toBeGreaterThan(0);
      for (const line of tagLines) {
        expect(line, `${rel}: "${line.trim()}" is missing --cleanup=verbatim`).toContain(
          '--cleanup=verbatim',
        );
      }
    });
  }
});

describe("git tag cleanup semantics — the behavior the flag protects (HS-9628)", () => {
  let dir: string;
  // A realistic release-note body: section headings + bullets + blank-line
  // grouping, exactly the shape gitgist emits.
  const NOTES = '## Beyond Claude\n\n- Codex drive\n\n## Reliability\n\n- Fixed a crash';

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'hs-tagcleanup-'));
    git(dir, ['init', '-q']);
    git(dir, ['config', 'user.email', 'test@example.com']);
    git(dir, ['config', 'user.name', 'Test']);
    git(dir, ['commit', '--allow-empty', '-q', '-m', 'init']);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('the default (strip) DROPS `##` headings — this is the bug', () => {
    git(dir, ['tag', '-a', 'v-strip', '-F', '-'], NOTES);
    const contents = git(dir, ['tag', '-l', '--format=%(contents)', 'v-strip']);

    expect(contents).not.toContain('## Beyond Claude');
    expect(contents).not.toContain('## Reliability');
    // The non-heading content still survives — matching the observed symptom
    // (bullets and blank-line grouping intact, only the labels vanish).
    expect(contents).toContain('- Codex drive');
  });

  it('--cleanup=verbatim KEEPS `##` headings — this is the fix', () => {
    git(dir, ['tag', '-a', 'v-verbatim', '--cleanup=verbatim', '-F', '-'], NOTES);
    const contents = git(dir, ['tag', '-l', '--format=%(contents)', 'v-verbatim']);

    expect(contents).toContain('## Beyond Claude');
    expect(contents).toContain('## Reliability');
    expect(contents).toContain('- Codex drive');
  });
});

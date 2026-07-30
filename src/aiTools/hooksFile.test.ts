/**
 * HS-9496 (docs/132 §132.9.1) — the merge-safe hooks-file writer.
 *
 * The per-tool suites (`skillsAntigravity.test.ts`) cover this through `ensureSkillsForDir`
 * and are the evidence the extraction preserved behavior. These test the helper DIRECTLY,
 * because the contract is mostly about what it must NOT destroy, and those paths are the
 * ones a per-tool test tends not to reach: a corrupt file, a file that is valid JSON but
 * the wrong shape, removal when nothing was ever installed, and repeat installs.
 *
 * Both container shapes are exercised on every case — root-level events (agy) and nested
 * under a key (codex) — since one helper now serves both and a bug in either shape would
 * otherwise show up as one tool's permission hooks quietly not working.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureHooksFile, type HooksFileSpec } from './hooksFile.js';

let dir: string;
const pathOf = (): string => join(dir, 'hooks.json');

/** Root-level events, one group, with a `//` comment — agy's shape. */
const ROOT_SPEC = (): HooksFileSpec => ({
  path: pathOf(),
  marker: '__test-marker',
  container: null,
  command: 'run __test-marker',
  timeout: 600,
  comment: 'Hot Sheet interactive permissions',
  groups: [{ event: 'PreToolUse', matcher: '' }],
});

/** Events nested under `hooks`, two groups — codex's shape. */
const NESTED_SPEC = (): HooksFileSpec => ({
  path: pathOf(),
  marker: '__test-marker',
  container: 'hooks',
  command: 'run __test-marker',
  timeout: 180,
  groups: [
    { event: 'PreToolUse', matcher: '^(Bash)$' },
    { event: 'PermissionRequest', matcher: '*' },
  ],
});

const SHAPES: [string, () => HooksFileSpec][] = [['root-level (agy)', ROOT_SPEC], ['nested (codex)', NESTED_SPEC]];

function read(): Record<string, unknown> {
  return JSON.parse(readFileSync(pathOf(), 'utf-8')) as Record<string, unknown>;
}

/** Every hook command anywhere in the file, regardless of shape. */
function allCommands(): string[] {
  const found: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (typeof v !== 'object' || v === null) return;
    const rec = v as Record<string, unknown>;
    if (typeof rec.command === 'string') found.push(rec.command);
    Object.values(rec).forEach(walk);
  };
  walk(read());
  return found;
}

beforeEach(() => {
  dir = join(tmpdir(), `hs-hooks-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe.each(SHAPES)('ensureHooksFile — %s (HS-9496)', (_label, spec) => {
  it('installs into a project with no hooks file', () => {
    expect(ensureHooksFile(spec(), true)).toBe(true);
    expect(allCommands()).toContain('run __test-marker');
  });

  it('is idempotent — a second install writes nothing', () => {
    expect(ensureHooksFile(spec(), true)).toBe(true);
    expect(ensureHooksFile(spec(), true)).toBe(false);
  });

  it('REPLACES our prior group rather than accumulating one per pass', () => {
    ensureHooksFile(spec(), true);
    // A changed command is an update, not a second copy — otherwise every generation
    // pass after a version bump would stack another hook onto the same event.
    const changed = { ...spec(), command: 'run __test-marker --v2' };
    expect(ensureHooksFile(changed, true)).toBe(true);
    // One entry per declared group (agy installs into one event, codex into two) — and
    // every one of them the NEW command, with no copy of the old left behind.
    const ours = allCommands().filter(c => c.includes('__test-marker'));
    expect(ours).toEqual(spec().groups.map(() => 'run __test-marker --v2'));
  });

  it('preserves foreign hooks on install', () => {
    const foreign = { matcher: 'X', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] };
    const s = spec();
    const initial = s.container === null
      ? { PreToolUse: [foreign], unrelatedSetting: 42 }
      : { hooks: { PreToolUse: [foreign] }, unrelatedSetting: 42 };
    writeFileSync(pathOf(), JSON.stringify(initial), 'utf-8');

    ensureHooksFile(s, true);
    expect(allCommands()).toContain('my-own-hook.sh');
    expect(allCommands()).toContain('run __test-marker');
    // Unrelated top-level settings survive too — we occupy one group, not the file.
    expect(read().unrelatedSetting).toBe(42);
  });

  it('preserves foreign hooks on REMOVAL — the property most likely to break silently', () => {
    const foreign = { matcher: 'X', hooks: [{ type: 'command', command: 'my-own-hook.sh' }] };
    const s = spec();
    const initial = s.container === null
      ? { PreToolUse: [foreign] }
      : { hooks: { PreToolUse: [foreign] } };
    writeFileSync(pathOf(), JSON.stringify(initial), 'utf-8');

    ensureHooksFile(s, true);
    ensureHooksFile(s, false);
    expect(allCommands()).toContain('my-own-hook.sh');
    expect(allCommands().some(c => c.includes('__test-marker'))).toBe(false);
  });

  it('removal leaves NO trace when the file was ours alone', () => {
    ensureHooksFile(spec(), true);
    expect(ensureHooksFile(spec(), false)).toBe(true);
    // Emptied, not `{}` — a stray empty object reads like a config someone meant to write.
    expect(readFileSync(pathOf(), 'utf-8')).toBe('');
  });

  it('removal is a no-op when we were never installed', () => {
    expect(ensureHooksFile(spec(), false)).toBe(false);
    expect(existsSync(pathOf())).toBe(false);
  });

  it('leaves a CORRUPT file completely alone', () => {
    const garbage = '{ this is not json';
    writeFileSync(pathOf(), garbage, 'utf-8');
    expect(ensureHooksFile(spec(), true)).toBe(false);
    expect(readFileSync(pathOf(), 'utf-8')).toBe(garbage);
  });

  it('leaves a file that is valid JSON but the wrong SHAPE alone', () => {
    // Pre-HS-9496 the agy path adopted an array here and wrote a property onto it,
    // which serializes to `[]` — silently destroying whatever the user had.
    for (const content of ['[1,2,3]', '"a string"', 'null', '42']) {
      writeFileSync(pathOf(), content, 'utf-8');
      expect(ensureHooksFile(spec(), true), `should refuse ${content}`).toBe(false);
      expect(readFileSync(pathOf(), 'utf-8')).toBe(content);
    }
  });

  it('ignores a group whose marker is merely similar', () => {
    // Marker matching is a substring test, so a user hook named close to ours must not
    // be mistaken for ours and deleted.
    const nearMiss = { matcher: 'Y', hooks: [{ type: 'command', command: 'run __test-marker-OTHER-TOOL' }] };
    const s = { ...spec(), marker: '__test-marker-EXACT', command: 'run __test-marker-EXACT' };
    const initial = s.container === null ? { PreToolUse: [nearMiss] } : { hooks: { PreToolUse: [nearMiss] } };
    writeFileSync(pathOf(), JSON.stringify(initial), 'utf-8');

    ensureHooksFile(s, false); // remove ours — the near-miss must survive
    expect(allCommands()).toContain('run __test-marker-OTHER-TOOL');
  });
});

describe('ensureHooksFile — shape specifics (HS-9496)', () => {
  it('root shape writes events at the top level, with the comment first', () => {
    ensureHooksFile(ROOT_SPEC(), true);
    const cfg = read() as { PreToolUse?: Record<string, unknown>[] };
    expect(cfg.PreToolUse).toBeDefined();
    // Key order matters only for how the file reads to a human, but the `//` comment
    // exists for exactly that reason, so it should lead.
    expect(Object.keys(cfg.PreToolUse![0])).toEqual(['//', 'matcher', 'hooks']);
  });

  it('nested shape writes both events under the container key', () => {
    ensureHooksFile(NESTED_SPEC(), true);
    const cfg = read() as { hooks?: Record<string, unknown[]> };
    expect(Object.keys(cfg.hooks ?? {}).sort()).toEqual(['PermissionRequest', 'PreToolUse']);
    // No `//` comment declared for this shape — it should not appear.
    expect(JSON.stringify(cfg)).not.toContain('"//"');
  });

  it('nested shape drops the container entirely on removal', () => {
    ensureHooksFile(NESTED_SPEC(), true);
    writeFileSync(pathOf(), JSON.stringify({ ...read(), keepMe: true }), 'utf-8');
    ensureHooksFile(NESTED_SPEC(), false);
    expect(read().hooks).toBeUndefined();
    expect(read().keepMe).toBe(true); // the rest of the file survives
  });
});

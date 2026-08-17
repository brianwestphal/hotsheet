// HS-9676 — the injected-worker-identity helpers. These are the seam that keeps
// a pooled worker's claims attributed to its stable LEASE id (`worker-1`) instead
// of the generated worktree/tab INSTANCE name (`hotsheet-worker-1-12`).
import { describe, expect, it } from 'vitest';

import { resolveWorkerActor, WORKER_ID_ENV, workerIdEnvPrefix, workerIdFromBranch, workerIdPromptLine } from './workerIdentity.js';

describe('workerIdEnvPrefix (HS-9676)', () => {
  it('emits a shell-safe env assignment for a slug id', () => {
    expect(workerIdEnvPrefix('worker-1')).toBe(`${WORKER_ID_ENV}=worker-1 `);
    expect(workerIdEnvPrefix('worker-1-12')).toBe(`${WORKER_ID_ENV}=worker-1-12 `);
  });

  it('emits nothing when no id is known', () => {
    expect(workerIdEnvPrefix(undefined)).toBe('');
    expect(workerIdEnvPrefix('')).toBe('');
  });

  it('drops a non-slug id rather than emit an unquoted, shell-unsafe assignment', () => {
    for (const bad of ['a b', 'a;rm -rf', 'a$(x)', 'a`x`', 'a/b', '-lead', 'UP']) {
      expect(workerIdEnvPrefix(bad)).toBe('');
    }
  });
});

describe('workerIdPromptLine (HS-9676)', () => {
  it('states the id verbatim and forbids deriving it from the folder/tab', () => {
    const line = workerIdPromptLine('worker-1');
    expect(line).toContain('canonical worker id is worker-1');
    expect(line).toMatch(/Do NOT derive your id from the worktree folder name or the tab title/);
    // No backticks/quotes — it goes inside a double-quoted shell arg (a backtick
    // there would be command substitution).
    expect(line).not.toContain('`');
    expect(line).not.toContain('"');
  });

  it('is empty when no id is known', () => {
    expect(workerIdPromptLine(undefined)).toBe('');
    expect(workerIdPromptLine('')).toBe('');
  });
});

describe('workerIdFromBranch (HS-9676)', () => {
  it('strips the hotsheet/ prefix (the skill fallback when the env is unset)', () => {
    expect(workerIdFromBranch('hotsheet/worker-1')).toBe('worker-1');
    // A deduped branch keeps its suffix — still the lease id for THAT branch.
    expect(workerIdFromBranch('hotsheet/worker-1-2')).toBe('worker-1-2');
  });

  it('returns null for a non-worker branch or missing value', () => {
    expect(workerIdFromBranch('main')).toBeNull();
    expect(workerIdFromBranch('feature/x')).toBeNull();
    expect(workerIdFromBranch('hotsheet/')).toBeNull();
    expect(workerIdFromBranch(null)).toBeNull();
    expect(workerIdFromBranch(undefined)).toBeNull();
  });
});

describe('resolveWorkerActor (HS-9676 — the server-side auto-claim actor)', () => {
  // The whole point: the actor must equal what the skill sends, so auto-claim-on-
  // write doesn't conflict with the worker's explicit claim/renew/release.
  it('uses the injected id and does NOT touch git (the normal launcher path)', () => {
    let branchReads = 0;
    const actor = resolveWorkerActor('/wt/hotsheet-worker-1-12', 'worker-1', () => { branchReads++; return 'hotsheet/worker-1-12'; });
    expect(actor).toBe('worker-1');            // the lease id, not the folder
    expect(branchReads).toBe(0);               // env short-circuits — no git shell-out
  });

  it('falls back to the hotsheet/<id> branch when the env is unset', () => {
    const actor = resolveWorkerActor('/wt/hotsheet-worker-1-12', undefined, () => 'hotsheet/worker-1');
    expect(actor).toBe('worker-1');
  });

  it('falls back to the folder basename only when neither env nor a worker branch is available', () => {
    expect(resolveWorkerActor('/wt/hotsheet-worker-1-12', undefined, () => 'main')).toBe('hotsheet-worker-1-12');
    expect(resolveWorkerActor('/wt/hotsheet-worker-1-12', undefined, () => null)).toBe('hotsheet-worker-1-12');
    expect(resolveWorkerActor('/wt/hotsheet-worker-1-12', '', () => null)).toBe('hotsheet-worker-1-12');
  });
});

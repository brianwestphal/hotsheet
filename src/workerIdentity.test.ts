// The claiming-agent LEASE identity used by `deriveChannelActor` (the worker pool
// that once INJECTED it was retired in HS-9686; an agent now sets the env itself
// or is identified by its `hotsheet/<id>` branch).
import { describe, expect, it } from 'vitest';

import { resolveWorkerActor, workerIdFromBranch } from './workerIdentity.js';

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

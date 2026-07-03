// HS-9112 — the per-project pending agent-partition-proposal slot.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { PartitionAssignment } from '../api/workers.js';
import { _resetProposalsForTesting, clearProposal, getProposal, setProposal } from './proposalSlot.js';

const A: PartitionAssignment[] = [
  { worker: 'worker-1', label: 'Worker 1', ticketIds: [1, 2], ticketNumbers: ['HS-1', 'HS-2'] },
];
const B: PartitionAssignment[] = [
  { worker: 'worker-2', label: 'Worker 2', ticketIds: [3], ticketNumbers: ['HS-3'] },
];

describe('proposalSlot', () => {
  beforeEach(() => { _resetProposalsForTesting(); });
  afterEach(() => { _resetProposalsForTesting(); });

  it('returns null when nothing is set', () => {
    expect(getProposal('sec-a')).toBeNull();
  });

  it('stores + reads a proposal per secret', () => {
    setProposal('sec-a', A);
    expect(getProposal('sec-a')).toEqual({ assignments: A });
    expect(getProposal('sec-b')).toBeNull(); // isolated per project
  });

  it('a later set replaces the prior proposal', () => {
    setProposal('sec-a', A);
    setProposal('sec-a', B);
    expect(getProposal('sec-a')).toEqual({ assignments: B });
  });

  it('clear removes only that secret’s proposal', () => {
    setProposal('sec-a', A);
    setProposal('sec-b', B);
    clearProposal('sec-a');
    expect(getProposal('sec-a')).toBeNull();
    expect(getProposal('sec-b')).toEqual({ assignments: B });
  });

  it('clear is a no-op when nothing is pending', () => {
    expect(() => clearProposal('sec-none')).not.toThrow();
    expect(getProposal('sec-none')).toBeNull();
  });
});

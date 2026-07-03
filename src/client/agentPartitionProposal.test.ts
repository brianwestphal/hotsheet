// HS-9112 — the client agent-partition-proposal orchestration: open the editor,
// dispatch each chunk on accept (nothing on cancel), skip empty proposals, and
// clear the server slot on consume. The editor + dispatch + api are mocked so we
// assert the wiring without a DOM or network.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PartitionAssignment } from '../api/workers.js';

const openPartitionEditor = vi.fn<(input: readonly PartitionAssignment[], onApply: (chunks: PartitionAssignment[]) => void | Promise<void>) => void>();
const dispatchAndReport = vi.fn(() => Promise.resolve({ dispatched: [], failed: [] }));
const clearPartitionProposal = vi.fn(() => Promise.resolve());
const getPendingPartitionProposal = vi.fn<() => Promise<PartitionAssignment[] | null>>();

vi.mock('./partitionEditor.js', () => ({ openPartitionEditor: (...a: unknown[]) => openPartitionEditor(...(a as [readonly PartitionAssignment[], (chunks: PartitionAssignment[]) => void])) }));
vi.mock('./dispatch.js', () => ({ dispatchAndReport: (...a: unknown[]) => dispatchAndReport(...(a as [])) }));
vi.mock('../api/workers.js', () => ({
  clearPartitionProposal: () => clearPartitionProposal(),
  getPendingPartitionProposal: () => getPendingPartitionProposal(),
}));

// eslint-disable-next-line import/first
import { checkPendingPartitionProposal, onWorkerPartitionProposed } from './agentPartitionProposal.js';

const PLAN: PartitionAssignment[] = [
  { worker: 'w1', label: 'W1', ticketIds: [1, 2], ticketNumbers: ['HS-1', 'HS-2'] },
  { worker: 'w2', label: 'W2', ticketIds: [], ticketNumbers: [] },
  { worker: 'w3', label: 'W3', ticketIds: [3], ticketNumbers: ['HS-3'] },
];

describe('onWorkerPartitionProposed', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('opens the editor with the proposed plan and clears the slot (consumed)', () => {
    onWorkerPartitionProposed(PLAN);
    expect(openPartitionEditor).toHaveBeenCalledTimes(1);
    expect(openPartitionEditor.mock.calls[0][0]).toEqual(PLAN);
    expect(clearPartitionProposal).toHaveBeenCalledTimes(1);
  });

  it('on accept dispatches each NON-empty chunk (the human commits the work)', async () => {
    onWorkerPartitionProposed(PLAN);
    const onApply = openPartitionEditor.mock.calls[0][1];
    await onApply(PLAN); // the editor hands back the (possibly edited) chunks
    // w2 is empty → skipped; w1 + w3 dispatched.
    expect(dispatchAndReport).toHaveBeenCalledTimes(2);
    expect(dispatchAndReport).toHaveBeenCalledWith('w1', 'W1', [1, 2]);
    expect(dispatchAndReport).toHaveBeenCalledWith('w3', 'W3', [3]);
  });

  it('does nothing (no dispatch) if the editor is cancelled — onApply never runs', () => {
    onWorkerPartitionProposed(PLAN);
    // Simulate cancel: the caller never invokes onApply.
    expect(dispatchAndReport).not.toHaveBeenCalled();
  });

  it('skips a proposal with no work (does not open the editor)', () => {
    onWorkerPartitionProposed([{ worker: 'w1', label: 'W1', ticketIds: [], ticketNumbers: [] }]);
    expect(openPartitionEditor).not.toHaveBeenCalled();
    expect(clearPartitionProposal).not.toHaveBeenCalled();
  });
});

describe('checkPendingPartitionProposal', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('opens the editor when a proposal is pending', async () => {
    getPendingPartitionProposal.mockResolvedValueOnce(PLAN);
    await checkPendingPartitionProposal();
    expect(openPartitionEditor).toHaveBeenCalledTimes(1);
  });

  it('does nothing when none is pending', async () => {
    getPendingPartitionProposal.mockResolvedValueOnce(null);
    await checkPendingPartitionProposal();
    expect(openPartitionEditor).not.toHaveBeenCalled();
  });

  it('swallows a fetch error', async () => {
    getPendingPartitionProposal.mockRejectedValueOnce(new Error('offline'));
    await expect(checkPendingPartitionProposal()).resolves.toBeUndefined();
    expect(openPartitionEditor).not.toHaveBeenCalled();
  });
});

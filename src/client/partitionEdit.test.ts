import { describe, expect, it } from 'vitest';

import { createPartitionEdit, type PartitionInput } from './partitionEdit.js';

const INPUT: PartitionInput[] = [
  { worker: 'w1', label: 'Worker 1', ticketIds: [1, 2], ticketNumbers: ['HS-1', 'HS-2'] },
  { worker: 'w2', label: 'Worker 2', ticketIds: [3], ticketNumbers: ['HS-3'] },
];

describe('createPartitionEdit', () => {
  it('exposes workers, ticket numbers, and initial assignment', () => {
    const e = createPartitionEdit(INPUT);
    expect(e.workers).toEqual([{ worker: 'w1', label: 'Worker 1' }, { worker: 'w2', label: 'Worker 2' }]);
    expect(e.ticketNumber(2)).toBe('HS-2');
    expect(e.assignedWorker(1)).toBe('w1');
    expect(e.assignedWorker(3)).toBe('w2');
    expect(e.ticketsFor('w1')).toEqual([1, 2]);
    expect(e.ticketsFor('w2')).toEqual([3]);
  });

  it('moves a ticket between workers', () => {
    const e = createPartitionEdit(INPUT);
    e.move(2, 'w2');
    expect(e.assignedWorker(2)).toBe('w2');
    expect(e.ticketsFor('w1')).toEqual([1]);
    expect(e.ticketsFor('w2')).toEqual([2, 3]); // stable original order (2 before 3)
  });

  it('no-ops moving an unknown ticket or to an unknown worker', () => {
    const e = createPartitionEdit(INPUT);
    e.move(999, 'w2');
    e.move(1, 'nope');
    expect(e.assignedWorker(1)).toBe('w1');
    expect(e.ticketsFor('w1')).toEqual([1, 2]);
  });

  it('assignments() lists every worker (incl. emptied); nonEmptyAssignments filters', () => {
    const e = createPartitionEdit(INPUT);
    e.move(3, 'w1'); // empty w2
    expect(e.assignments()).toEqual([
      { worker: 'w1', label: 'Worker 1', ticketIds: [1, 2, 3] },
      { worker: 'w2', label: 'Worker 2', ticketIds: [] },
    ]);
    expect(e.nonEmptyAssignments()).toEqual([
      { worker: 'w1', label: 'Worker 1', ticketIds: [1, 2, 3] },
    ]);
  });

  it('falls back to #id when a ticket number is missing', () => {
    const e = createPartitionEdit([{ worker: 'w1', label: 'W1', ticketIds: [5], ticketNumbers: [] }]);
    expect(e.ticketNumber(5)).toBe('#5');
  });
});

// HS-8977 — pure model behind the editable AI-partition overlay (docs/92 §92.6).
// Holds which ticket is assigned to which worker so the owner can move tickets
// between workers before applying. No DOM — the overlay (`partitionEditor.tsx`)
// renders + mutates this, then dispatches each non-empty chunk via the existing
// `dispatchTicketsToWorker` path.

export interface PartitionWorker { worker: string; label: string }

/** One worker's proposed chunk, as returned by `getTicketPartition`. */
export interface PartitionInput {
  worker: string;
  label: string;
  ticketIds: readonly number[];
  ticketNumbers: readonly string[];
}

/** A worker + its assigned tickets, ready to dispatch. */
export interface PartitionAssignment { worker: string; label: string; ticketIds: number[] }

export interface PartitionEdit {
  readonly workers: readonly PartitionWorker[];
  /** Human ticket number (e.g. `HS-12`) for an id. */
  ticketNumber(id: number): string;
  /** The worker an id is currently assigned to. */
  assignedWorker(id: number): string;
  /** Reassign a ticket to another worker (no-op for an unknown ticket/worker). */
  move(ticketId: number, toWorker: string): void;
  /** Ticket ids assigned to a worker, in the original stable display order. */
  ticketsFor(worker: string): number[];
  /** The full per-worker assignment (every worker, including now-empty ones). */
  assignments(): PartitionAssignment[];
  /** Only workers that still have ≥1 ticket — the dispatch set. */
  nonEmptyAssignments(): PartitionAssignment[];
}

export function createPartitionEdit(input: readonly PartitionInput[]): PartitionEdit {
  const workers: PartitionWorker[] = input.map(a => ({ worker: a.worker, label: a.label }));
  const workerSet = new Set(workers.map(w => w.worker));
  const labelOf = new Map(workers.map(w => [w.worker, w.label]));
  const assignment = new Map<number, string>();
  const numberOf = new Map<number, string>();
  // Stable order = the order tickets first appear across the input chunks.
  const order: number[] = [];

  for (const chunk of input) {
    chunk.ticketIds.forEach((id, i) => {
      if (!assignment.has(id)) order.push(id);
      assignment.set(id, chunk.worker);
      numberOf.set(id, chunk.ticketNumbers[i] ?? `#${String(id)}`);
    });
  }

  function ticketsFor(worker: string): number[] {
    return order.filter(id => assignment.get(id) === worker);
  }

  return {
    workers,
    ticketNumber: (id) => numberOf.get(id) ?? `#${String(id)}`,
    assignedWorker: (id) => assignment.get(id) ?? '',
    move(ticketId, toWorker) {
      if (!assignment.has(ticketId) || !workerSet.has(toWorker)) return;
      assignment.set(ticketId, toWorker);
    },
    ticketsFor,
    assignments() {
      return workers.map(w => ({ worker: w.worker, label: labelOf.get(w.worker) ?? w.worker, ticketIds: ticketsFor(w.worker) }));
    },
    nonEmptyAssignments() {
      return this.assignments().filter(a => a.ticketIds.length > 0);
    },
  };
}

export interface TicketSnapshot {
  id: number;
  title: string;
  details: string;
  category: string;
  priority: string;
  status: string;
  up_next: boolean;
  notes?: string;
}

export interface UndoEntry {
  label: string;
  timestamp: number;
  before: TicketSnapshot[];
  after: TicketSnapshot[];
  /** Key for coalescing text edits, e.g. "42:title" */
  coalescingKey?: string;
}

export type TicketCategory = 'issue' | 'bug' | 'feature' | 'requirement_change' | 'task' | 'investigation';
export type TicketPriority = 'highest' | 'high' | 'default' | 'low' | 'lowest';
export type TicketStatus = 'not_started' | 'started' | 'completed' | 'verified' | 'deleted';

export interface Ticket {
  id: number;
  ticket_number: string;
  title: string;
  details: string;
  category: TicketCategory;
  priority: TicketPriority;
  status: TicketStatus;
  up_next: boolean;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  verified_at: string | null;
  deleted_at: string | null;
  notes: string;
}

export interface Attachment {
  id: number;
  ticket_id: number;
  original_filename: string;
  stored_path: string;
  created_at: string;
}

export interface TicketFilters {
  category?: TicketCategory;
  priority?: TicketPriority;
  status?: TicketStatus | 'open' | 'non_verified';
  up_next?: boolean;
  search?: string;
  sort_by?: 'created' | 'priority' | 'category' | 'status' | 'ticket_number';
  sort_dir?: 'asc' | 'desc';
}

export const CATEGORIES: { value: TicketCategory; label: string; color: string }[] = [
  { value: 'issue', label: 'Issue', color: '#6b7280' },
  { value: 'bug', label: 'Bug', color: '#ef4444' },
  { value: 'feature', label: 'Feature', color: '#22c55e' },
  { value: 'requirement_change', label: 'Req Change', color: '#f97316' },
  { value: 'task', label: 'Task', color: '#3b82f6' },
  { value: 'investigation', label: 'Investigation', color: '#8b5cf6' },
];

export const PRIORITIES: { value: TicketPriority; label: string; icon: string }[] = [
  { value: 'highest', label: 'Highest', icon: '⬆⬆' },
  { value: 'high', label: 'High', icon: '⬆' },
  { value: 'default', label: 'Default', icon: '—' },
  { value: 'low', label: 'Low', icon: '⬇' },
  { value: 'lowest', label: 'Lowest', icon: '⬇⬇' },
];

export const STATUSES: { value: TicketStatus; label: string }[] = [
  { value: 'not_started', label: 'Not Started' },
  { value: 'started', label: 'Started' },
  { value: 'completed', label: 'Completed' },
  { value: 'verified', label: 'Verified' },
];

export const CATEGORY_DESCRIPTIONS: Record<TicketCategory, string> = {
  issue: 'General issues that need attention',
  bug: 'Bugs that should be fixed in the codebase',
  feature: 'New features to be implemented',
  requirement_change: 'Changes to existing requirements',
  task: 'General tasks to complete',
  investigation: 'Items requiring research or analysis',
};

export interface AppEnv {
  Variables: {
    dataDir: string;
  };
}

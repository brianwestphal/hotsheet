export type TicketCategory = string;
export type TicketPriority = 'highest' | 'high' | 'default' | 'low' | 'lowest';
export type TicketStatus = 'not_started' | 'started' | 'completed' | 'verified' | 'backlog' | 'archive' | 'deleted';

export interface CategoryDef {
  id: string;
  label: string;
  shortLabel: string;
  color: string;
  shortcutKey: string;
  description: string;
}

export interface CategoryPreset {
  id: string;
  name: string;
  categories: CategoryDef[];
}

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
  tags: string;
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
  status?: TicketStatus | 'open' | 'non_verified' | 'active';
  up_next?: boolean;
  search?: string;
  sort_by?: 'created' | 'priority' | 'category' | 'status';
  sort_dir?: 'asc' | 'desc';
}

export const DEFAULT_CATEGORIES: CategoryDef[] = [
  { id: 'issue', label: 'Issue', shortLabel: 'ISS', color: '#6b7280', shortcutKey: 'i', description: 'General issues that need attention' },
  { id: 'bug', label: 'Bug', shortLabel: 'BUG', color: '#ef4444', shortcutKey: 'b', description: 'Bugs that should be fixed in the codebase' },
  { id: 'feature', label: 'Feature', shortLabel: 'FEA', color: '#22c55e', shortcutKey: 'f', description: 'New features to be implemented' },
  { id: 'requirement_change', label: 'Req Change', shortLabel: 'REQ', color: '#f97316', shortcutKey: 'r', description: 'Changes to existing requirements' },
  { id: 'task', label: 'Task', shortLabel: 'TSK', color: '#3b82f6', shortcutKey: 'k', description: 'General tasks to complete' },
  { id: 'investigation', label: 'Investigation', shortLabel: 'INV', color: '#8b5cf6', shortcutKey: 'g', description: 'Items requiring research or analysis' },
];

export const CATEGORY_PRESETS: CategoryPreset[] = [
  {
    id: 'software',
    name: 'Software Development',
    categories: DEFAULT_CATEGORIES,
  },
  {
    id: 'design',
    name: 'Design / Creative',
    categories: [
      { id: 'concept', label: 'Concept', shortLabel: 'CON', color: '#8b5cf6', shortcutKey: 'c', description: 'Design concepts and explorations' },
      { id: 'revision', label: 'Revision', shortLabel: 'REV', color: '#f97316', shortcutKey: 'r', description: 'Revisions to existing designs' },
      { id: 'feedback', label: 'Feedback', shortLabel: 'FDB', color: '#3b82f6', shortcutKey: 'f', description: 'Client or stakeholder feedback to address' },
      { id: 'asset', label: 'Asset', shortLabel: 'AST', color: '#22c55e', shortcutKey: 'a', description: 'Assets to produce or deliver' },
      { id: 'research', label: 'Research', shortLabel: 'RSC', color: '#6b7280', shortcutKey: 's', description: 'User research or competitive analysis' },
      { id: 'bug', label: 'Bug', shortLabel: 'BUG', color: '#ef4444', shortcutKey: 'b', description: 'Visual or UI bugs' },
    ],
  },
  {
    id: 'product',
    name: 'Product Management',
    categories: [
      { id: 'epic', label: 'Epic', shortLabel: 'EPC', color: '#8b5cf6', shortcutKey: 'e', description: 'Large initiatives spanning multiple stories' },
      { id: 'story', label: 'Story', shortLabel: 'STY', color: '#3b82f6', shortcutKey: 's', description: 'User stories describing desired functionality' },
      { id: 'bug', label: 'Bug', shortLabel: 'BUG', color: '#ef4444', shortcutKey: 'b', description: 'Bugs that need to be fixed' },
      { id: 'task', label: 'Task', shortLabel: 'TSK', color: '#22c55e', shortcutKey: 't', description: 'Tasks to complete' },
      { id: 'spike', label: 'Spike', shortLabel: 'SPK', color: '#f97316', shortcutKey: 'k', description: 'Research or investigation spikes' },
      { id: 'debt', label: 'Tech Debt', shortLabel: 'DBT', color: '#6b7280', shortcutKey: 'd', description: 'Technical debt to address' },
    ],
  },
  {
    id: 'marketing',
    name: 'Marketing',
    categories: [
      { id: 'campaign', label: 'Campaign', shortLabel: 'CMP', color: '#8b5cf6', shortcutKey: 'c', description: 'Marketing campaigns' },
      { id: 'content', label: 'Content', shortLabel: 'CNT', color: '#3b82f6', shortcutKey: 'n', description: 'Content to create or publish' },
      { id: 'design', label: 'Design', shortLabel: 'DES', color: '#22c55e', shortcutKey: 'd', description: 'Design requests and assets' },
      { id: 'analytics', label: 'Analytics', shortLabel: 'ANL', color: '#f97316', shortcutKey: 'a', description: 'Analytics and reporting tasks' },
      { id: 'outreach', label: 'Outreach', shortLabel: 'OUT', color: '#6b7280', shortcutKey: 'o', description: 'Outreach and partnership activities' },
      { id: 'event', label: 'Event', shortLabel: 'EVT', color: '#ef4444', shortcutKey: 'e', description: 'Events to plan or manage' },
    ],
  },
  {
    id: 'personal',
    name: 'Personal',
    categories: [
      { id: 'task', label: 'Task', shortLabel: 'TSK', color: '#3b82f6', shortcutKey: 't', description: 'Things to do' },
      { id: 'idea', label: 'Idea', shortLabel: 'IDA', color: '#22c55e', shortcutKey: 'i', description: 'Ideas to explore' },
      { id: 'note', label: 'Note', shortLabel: 'NTE', color: '#6b7280', shortcutKey: 'n', description: 'Notes and references' },
      { id: 'errand', label: 'Errand', shortLabel: 'ERR', color: '#f97316', shortcutKey: 'e', description: 'Errands and appointments' },
      { id: 'project', label: 'Project', shortLabel: 'PRJ', color: '#8b5cf6', shortcutKey: 'p', description: 'Larger projects' },
      { id: 'urgent', label: 'Urgent', shortLabel: 'URG', color: '#ef4444', shortcutKey: 'u', description: 'Urgent items' },
    ],
  },
];

// --- Custom Views ---

export interface CustomViewCondition {
  field: 'category' | 'priority' | 'status' | 'title' | 'details' | 'up_next' | 'tags';
  operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'lt' | 'lte' | 'gt' | 'gte';
  value: string;
}

export interface CustomView {
  id: string;
  name: string;
  tag?: string;
  logic: 'all' | 'any';
  conditions: CustomViewCondition[];
}

// Legacy compat aliases used by server-rendered pages and older code
export const CATEGORIES = DEFAULT_CATEGORIES.map(c => ({ value: c.id, label: c.label, color: c.color }));
export const CATEGORY_DESCRIPTIONS: Record<string, string> = Object.fromEntries(
  DEFAULT_CATEGORIES.map(c => [c.id, c.description])
);

export const PRIORITIES: { value: TicketPriority; label: string; icon: string }[] = [
  { value: 'highest', label: 'Highest', icon: '\u2B06\u2B06' },
  { value: 'high', label: 'High', icon: '\u2B06' },
  { value: 'default', label: 'Default', icon: '\u2014' },
  { value: 'low', label: 'Low', icon: '\u2B07' },
  { value: 'lowest', label: 'Lowest', icon: '\u2B07\u2B07' },
];

export const STATUSES: { value: TicketStatus; label: string }[] = [
  { value: 'not_started', label: 'Not Started' },
  { value: 'started', label: 'Started' },
  { value: 'completed', label: 'Completed' },
  { value: 'verified', label: 'Verified' },
  { value: 'backlog', label: 'Backlog' },
  { value: 'archive', label: 'Archive' },
];

export interface AppEnv {
  Variables: {
    dataDir: string;
    projectSecret: string;
  };
}

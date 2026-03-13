export interface Ticket {
  id: number;
  ticket_number: string;
  title: string;
  details: string;
  category: string;
  priority: string;
  status: string;
  up_next: boolean;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  verified_at: string | null;
  deleted_at: string | null;
  notes: string;
  attachments?: Attachment[];
}

export interface Attachment {
  id: number;
  ticket_id: number;
  original_filename: string;
  stored_path: string;
  created_at: string;
}

export interface AppSettings {
  detail_position: 'side' | 'bottom';
  detail_width: number;
  detail_height: number;
  trash_cleanup_days: number;
  verified_cleanup_days: number;
}

export const DEFAULT_SETTINGS: AppSettings = {
  detail_position: 'side',
  detail_width: 360,
  detail_height: 300,
  trash_cleanup_days: 3,
  verified_cleanup_days: 30,
};

export interface AppState {
  tickets: Ticket[];
  selectedIds: Set<number>;
  lastClickedId: number | null;
  activeTicketId: number | null;
  view: string;
  layout: 'list' | 'columns';
  sortBy: string;
  sortDir: string;
  search: string;
  settings: AppSettings;
  backupPreview: {
    active: boolean;
    tickets: Ticket[];
    timestamp: string;
    tier: string;
    filename: string;
  } | null;
}

export const state: AppState = {
  tickets: [],
  selectedIds: new Set(),
  lastClickedId: null,
  activeTicketId: null,
  view: 'all',
  layout: 'list',
  sortBy: 'created',
  sortDir: 'desc',
  search: '',
  settings: { ...DEFAULT_SETTINGS },
  backupPreview: null,
};

const CATEGORY_COLORS: Record<string, string> = {
  issue: '#6b7280',
  bug: '#ef4444',
  feature: '#22c55e',
  requirement_change: '#f97316',
  task: '#3b82f6',
  investigation: '#8b5cf6',
};

const CATEGORY_LABELS: Record<string, string> = {
  issue: 'ISS',
  bug: 'BUG',
  feature: 'FEA',
  requirement_change: 'REQ',
  task: 'TSK',
  investigation: 'INV',
};

const PRIORITY_ICONS: Record<string, string> = {
  highest: '\u2B06\u2B06',
  high: '\u2B06',
  default: '\u2014',
  low: '\u2B07',
  lowest: '\u2B07\u2B07',
};

const PRIORITY_COLORS: Record<string, string> = {
  highest: '#ef4444',
  high: '#f97316',
  default: '#6b7280',
  low: '#3b82f6',
  lowest: '#94a3b8',
};

const STATUS_ICONS: Record<string, string> = {
  not_started: '\u25CB',
  started: '\u25D4',
  completed: '\u2713',
  verified: 'svg',
  backlog: '\u25A1',
  archive: '\u25A0',
};

export const VERIFIED_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 7 17l-5-5"/><path d="m22 10-9.5 9.5-2-2"/></svg>';

export function getCategoryColor(cat: string): string {
  return CATEGORY_COLORS[cat] || '#6b7280';
}

export function getCategoryLabel(cat: string): string {
  return CATEGORY_LABELS[cat] || 'ISS';
}

export function getPriorityIcon(pri: string): string {
  return PRIORITY_ICONS[pri] || '\u2014';
}

export function getPriorityColor(pri: string): string {
  return PRIORITY_COLORS[pri] || '#6b7280';
}

export function getStatusIcon(status: string): string {
  return STATUS_ICONS[status] || '\u25CB';
}

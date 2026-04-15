export interface ProjectInfo {
  name: string;
  dataDir: string;
  secret: string;
}

// Active project context — use getActiveProject() in modules that need the current value
// (esbuild IIFE bundling may not preserve ESM live bindings)
export let activeProject: ProjectInfo | null = null;
export function setActiveProject(project: ProjectInfo) { activeProject = project; }
export function getActiveProject(): ProjectInfo | null { return activeProject; }

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
  tags: string;
  last_read_at: string | null;
  attachments?: Attachment[];
}

export interface SyncInfo {
  pluginId: string;
  pluginName: string;
  remoteId: string;
  remoteUrl: string | null;
  syncStatus: string;
}

export interface SyncedTicketInfo {
  pluginId: string;
  icon?: string;
}

/** Map of ticket ID → sync info for synced tickets (for list indicators) */
export let syncedTicketMap: Record<number, SyncedTicketInfo> = {};
export function setSyncedTicketMap(map: Record<number, SyncedTicketInfo>) { syncedTicketMap = map; }

export interface Attachment {
  id: number;
  ticket_id: number;
  original_filename: string;
  stored_path: string;
  created_at: string;
}

export interface CategoryDef {
  id: string;
  label: string;
  shortLabel: string;
  color: string;
  shortcutKey: string;
  description: string;
}

export interface CustomViewCondition {
  field: 'category' | 'priority' | 'status' | 'title' | 'details' | 'up_next' | 'tags';
  operator: 'equals' | 'not_equals' | 'contains' | 'not_contains' | 'lt' | 'lte' | 'gt' | 'gte';
  value: string;
}

export interface CustomView {
  id: string;
  name: string;
  tag?: string;
  includeArchived?: boolean;
  logic: 'all' | 'any';
  conditions: CustomViewCondition[];
}

export type NotifyLevel = 'none' | 'once' | 'persistent';

export interface AppSettings {
  detail_position: 'side' | 'bottom';
  detail_visible: boolean;
  detail_width: number;
  detail_height: number;
  trash_cleanup_days: number;
  verified_cleanup_days: number;
  notify_permission: NotifyLevel;
  notify_completed: NotifyLevel;
  auto_order: boolean;
  hide_verified_column: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  detail_position: 'side',
  detail_visible: true,
  detail_width: 360,
  detail_height: 300,
  trash_cleanup_days: 3,
  verified_cleanup_days: 30,
  notify_permission: 'persistent',
  notify_completed: 'once',
  auto_order: true,
  hide_verified_column: false,
};

export interface AppState {
  tickets: Ticket[];
  categories: CategoryDef[];
  customViews: CustomView[];
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
  customViews: [],
  categories: [
    { id: 'issue', label: 'Issue', shortLabel: 'ISS', color: '#6b7280', shortcutKey: 'i', description: '' },
    { id: 'bug', label: 'Bug', shortLabel: 'BUG', color: '#ef4444', shortcutKey: 'b', description: '' },
    { id: 'feature', label: 'Feature', shortLabel: 'FEA', color: '#22c55e', shortcutKey: 'f', description: '' },
    { id: 'requirement_change', label: 'Req Change', shortLabel: 'REQ', color: '#f97316', shortcutKey: 'r', description: '' },
    { id: 'task', label: 'Task', shortLabel: 'TSK', color: '#3b82f6', shortcutKey: 'k', description: '' },
    { id: 'investigation', label: 'Investigation', shortLabel: 'INV', color: '#8b5cf6', shortcutKey: 'g', description: '' },
  ],
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

const LUCIDE_14 = 'xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

const PRIORITY_ICONS: Record<string, string> = {
  highest: `<svg ${LUCIDE_14}><path d="m7 11 5-5 5 5"/><path d="m7 17 5-5 5 5"/></svg>`,
  high: `<svg ${LUCIDE_14}><path d="m18 15-6-6-6 6"/></svg>`,
  default: `<svg ${LUCIDE_14}><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>`,
  low: `<svg ${LUCIDE_14}><path d="m6 9 6 6 6-6"/></svg>`,
  lowest: `<svg ${LUCIDE_14}><path d="m7 7 5 5 5-5"/><path d="m7 13 5 5 5-5"/></svg>`,
};

const PRIORITY_COLORS: Record<string, string> = {
  highest: '#ef4444',
  high: '#f97316',
  default: '#6b7280',
  low: '#3b82f6',
  lowest: '#94a3b8',
};

const CHECK_CHECK_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/></svg>';

const STATUS_ICONS: Record<string, string> = {
  not_started: '\u25CB',
  started: '\u25D4',
  completed: '\u2713',
  verified: CHECK_CHECK_SVG,
  backlog: '\u25A1',
  archive: '\u25A0',
};

export const VERIFIED_SVG = CHECK_CHECK_SVG;

export function getCategoryColor(cat: string): string {
  const def = state.categories.find(c => c.id === cat);
  return def?.color ?? '#6b7280';
}

export function getCategoryLabel(cat: string): string {
  const def = state.categories.find(c => c.id === cat);
  return def?.shortLabel ?? cat.slice(0, 3).toUpperCase();
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

// --- Canonical priority and status items (shared across batch, contextMenu, detail, ticketListState) ---

export const PRIORITY_ITEMS: { key: string; value: string; label: string }[] = [
  { key: '1', value: 'highest', label: 'Highest' },
  { key: '2', value: 'high', label: 'High' },
  { key: '3', value: 'default', label: 'Default' },
  { key: '4', value: 'low', label: 'Low' },
  { key: '5', value: 'lowest', label: 'Lowest' },
];

export const STATUS_ITEMS: { key: string; value: string; label: string }[] = [
  { key: 'n', value: 'not_started', label: 'Not Started' },
  { key: 's', value: 'started', label: 'Started' },
  { key: 'c', value: 'completed', label: 'Completed' },
  { key: 'v', value: 'verified', label: 'Verified' },
  { key: 'b', value: 'backlog', label: 'Backlog' },
  { key: 'a', value: 'archive', label: 'Archive' },
];

export const PRIORITY_LABELS: Record<string, string> = Object.fromEntries(PRIORITY_ITEMS.map(p => [p.value, p.label]));
export const STATUS_LABELS: Record<string, string> = Object.fromEntries(STATUS_ITEMS.map(s => [s.value, s.label]));

// --- Shared tags state ---

export let allKnownTags: string[] = [];

export async function refreshAllKnownTags(): Promise<void> {
  // Lazy import to avoid circular dependency at module init time
  const { api } = await import('./api.js');
  try { allKnownTags = await api<string[]>('/tags'); } catch { /* use cached */ }
}

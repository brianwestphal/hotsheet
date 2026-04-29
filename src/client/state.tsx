export interface ProjectInfo {
  name: string;
  dataDir: string;
  secret: string;
}

// Active project context — use getActiveProject() in modules that need the current value
// (esbuild IIFE bundling may not preserve ESM live bindings)
export let activeProject: ProjectInfo | null = null;
export function getActiveProject(): ProjectInfo | null { return activeProject; }

/** Per-project saved view state (keyed by project secret). */
const projectViews = new Map<string, string>();
/** HS-7360 — per-project search query (session-only, not persisted across
 *  app launches; cleared by project remove). Keyed by project secret. */
const projectSearches = new Map<string, string>();
/** HS-6311 — per-project drawer-grid mode flag. When true, the drawer is
 *  rendering its terminals as a tile grid instead of the normal per-terminal
 *  tab stack (see docs/36-drawer-terminal-grid.md). Session-only. */
const projectGridActive = new Map<string, boolean>();
/** HS-6311 — per-project slider value for the drawer-grid view (0..100,
 *  default 33 — same default as the terminal-dashboard slider). Session-only. */
const projectGridSliderValue = new Map<string, number>();

/** Switch active project, saving and restoring the sidebar view. */
export function setActiveProject(project: ProjectInfo) {
  // Save current project's view + search query + drawer-grid state
  if (activeProject != null) {
    projectViews.set(activeProject.secret, state.view);
    projectSearches.set(activeProject.secret, state.search);
    // HS-6311 — grid state maps are the canonical store; we never mirror
    // them into `state` so there's nothing else to save here. Grid-mode
    // module reads them directly via getProjectGridActive / Slider helpers.
  }
  activeProject = project;
  // Restore the new project's saved view (default to 'all') + search query
  // (default to '' — a fresh project tab starts with an empty search).
  state.view = projectViews.get(project.secret) ?? 'all';
  state.search = projectSearches.get(project.secret) ?? '';
}

/** HS-7360 — drop per-project state for a removed project so a future
 *  project registered at the same secret (reuse is unlikely but possible
 *  if the user deletes + re-adds the same folder) starts clean. */
export function clearPerProjectSessionState(secret: string): void {
  projectViews.delete(secret);
  projectSearches.delete(secret);
  // HS-6311 — also wipe drawer-grid state so a re-added project at the same
  // secret doesn't resurrect the prior project's grid-mode flag / slider.
  projectGridActive.delete(secret);
  projectGridSliderValue.delete(secret);
}

/** HS-6311 — drawer terminal grid per-project state. The drawer grid module
 *  (src/client/drawerTerminalGrid.tsx) calls these on enter / exit / slider
 *  change. Default slider value is 33 to match the terminal-dashboard default
 *  (see docs/25-terminal-dashboard.md §25.4 / HS-7129). */
export function getProjectGridActive(secret: string): boolean {
  return projectGridActive.get(secret) === true;
}
export function setProjectGridActive(secret: string, value: boolean): void {
  if (value) projectGridActive.set(secret, true);
  else projectGridActive.delete(secret);
}
export function getProjectGridSliderValue(secret: string): number {
  return projectGridSliderValue.get(secret) ?? 33;
}
export function setProjectGridSliderValue(secret: string, value: number): void {
  projectGridSliderValue.set(secret, value);
}

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
  /** HS-7269 — when false, OSC 133 shell-integration UI (gutter glyphs,
   *  copy-last-output button, Cmd/Ctrl+Arrow jump shortcuts, hover popover)
   *  does not render. The server-side parser still runs and markers are
   *  tracked, so toggling back on reveals the UI without losing history. */
  shell_integration_ui: boolean;
  /** HS-7988 (§52 Phase 4) — master switch for the terminal-prompt
   *  detector. When false the §52 detector short-circuits entirely; no
   *  parser runs, no overlay surfaces, no auto-allow gate. Existing
   *  `terminal_prompt_allow_rules` are preserved (settings UI shows them
   *  greyed-out for review) but inert. Default true so the feature is on
   *  for everyone after upgrade. */
  terminal_prompt_detection_enabled: boolean;
  /** HS-7984 (§53 Phase 4) — when false, the §53 streaming-shell-output
   *  partial render is suppressed on both client surfaces (sidebar row
   *  preview + Commands Log live `<pre>`). Server still buffers (cheap;
   *  conditional buffering would add complexity for no payoff). Default
   *  true so the behaviour is on for everyone after upgrade — the
   *  first-use toast on the very first `hotsheet:shell-partial-output`
   *  event makes the change discoverable. */
  shell_streaming_enabled: boolean;
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
  shell_integration_ui: true,
  terminal_prompt_detection_enabled: true,
  shell_streaming_enabled: true,
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
  /** HS-7756 — when the user clicks the "Include {N} backlog items" row
   *  under the multi-select toolbar, mix backlog rows into the search
   *  result set. Cleared on every fresh `state.search` change. */
  includeBacklogInSearch: boolean;
  includeArchiveInSearch: boolean;
  /** HS-7756 — view mode the user was in BEFORE either include row was
   *  toggled. We auto-switch column view → list view when including extras
   *  (column view groups by status; mixing in archive/backlog wouldn't
   *  fit) and revert to this on clear. `null` when no auto-switch is
   *  pending. */
  viewModeBeforeSearchInclude: 'list' | 'columns' | null;
  /** HS-7756 — last-fetched per-bucket search counts. Drives the
   *  visibility of the "Include {N} ..." rows. Both default to 0 when
   *  no search is active or no matches exist outside the active set. */
  searchExtraCounts: { backlog: number; archive: number };
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
  includeBacklogInSearch: false,
  includeArchiveInSearch: false,
  viewModeBeforeSearchInclude: null,
  searchExtraCounts: { backlog: 0, archive: 0 },
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

/**
 * HS-7998 \u2014 true when toggling up-next on a ticket with this status
 * should ALSO flip the status back to `not_started`. Out-of-active-
 * workflow statuses \u2014 `completed`, `verified`, `backlog`, `archive` \u2014
 * stay invisible from the default Up Next column unless the user
 * explicitly puts them back in motion. Adding such a ticket to Up Next
 * implies the user wants to work on it, so we reset the status as part
 * of the same toggle. Pre-fix this only fired for `completed` /
 * `verified`; backlog / archive items would star themselves but stay
 * invisible from Up Next, which the user filed as a bug.
 *
 * Pure for unit-testability \u2014 the three `toggleUpNext` callsites
 * (`ticketRow.tsx`, `app.tsx::bindDetailUpNext`, `actions.ts` batch)
 * import this rather than each maintaining their own status set.
 */
export function shouldResetStatusOnUpNext(status: string): boolean {
  return status === 'completed' || status === 'verified' || status === 'backlog' || status === 'archive';
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

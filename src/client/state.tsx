import type { SafeHtml } from '../jsx-runtime.js';
import type { TicketPriority, TicketStatus } from '../types.js';
import { activeProjectSignal, projectsStore } from './projectsStore.js';
import { ticketsStore } from './ticketsStore.js';

export interface ProjectInfo {
  name: string;
  dataDir: string;
  secret: string;
  // HS-9056 — populated by `listProjects()` (GET /api/projects); absent on
  // `ProjectInfo`s built elsewhere (e.g. `setActiveProject` in tests). The
  // terminal dashboard tile reads these via `projectsByIdSignal[secret]`.
  ticketCount?: number;
  openCount?: number;
  upNextCount?: number;
}

// Active project context — use getActiveProject() in modules that need the current value
// (esbuild IIFE bundling may not preserve ESM live bindings).
//
// HS-8317 (2026-05-10) — `activeProject` is now derived from the kerf
// `projectsStore` (in `projectsStore.ts`) via the `activeProjectSignal`
// computed. The accessor functions below are unchanged in their public
// contract; they delegate to the store so the two surfaces (the store +
// the projectTabs UI) stay in sync.
export function getActiveProject(): ProjectInfo | null {
  return activeProjectSignal.value;
}

/** Per-project saved view state (keyed by project secret). */
const projectViews = new Map<string, string>();
/** HS-7360 — per-project search query (session-only, not persisted across
 *  app launches; cleared by project remove). Keyed by project secret. */
const projectSearches = new Map<string, string>();
/** HS-6311 — per-project drawer-grid mode flag. When true, the drawer is
 *  rendering its terminals as a tile grid instead of the normal per-terminal
 *  tab stack (see docs/36-drawer-terminal-grid.md). Session-only. */
const projectGridActive = new Map<string, boolean>();
/** HS-6311 / HS-8176 — per-project tile-column count for the drawer-grid
 *  view (integer 1..10, default 4 — same default as the terminal-dashboard
 *  slider). Session-only. Pre-HS-8176 this stored a continuous 0..100
 *  slider value; the new integer-only slider stores `perRow` directly. */
const projectGridColumnCount = new Map<string, number>();
/** HS-8374 — per-`(project, view, preview-mode)` saved scroll position for
 *  the ticket-list container, session-only. Keyed by
 *  `${secret}::${view}::${preview ? 'preview' : 'live'}` so the user's
 *  scrollTop when they navigated AWAY from a (project, view) pair is
 *  restored when they navigate BACK. Required under HS-8371 list-
 *  virtualization because the wrapper computes the windowed slice from
 *  `scrollTop / rowHeight`; if a project switch lands the new project's
 *  list at the OLD project's saved scrollTop, the user sees the right
 *  rows at the right offset without any flash. Pre-virtualization the
 *  scroll position was implicitly preserved because the row container's
 *  element identity survived across re-renders; under virtualization
 *  the row container's `scrollHeight` changes with N so we have to
 *  persist + restore explicitly. */
const projectViewScrollPositions = new Map<string, number>();

/** Switch active project, saving and restoring the sidebar view.
 *
 *  HS-8317 — the active-secret + project list both live in the kerf
 *  `projectsStore` now. This wrapper preserves the per-project view +
 *  search save/restore side effect (which is NOT store state — those
 *  Maps are session-only render-state by-project). The store action
 *  is a single secret-pointer update; everything else here is the
 *  view/search persistence dance the pre-fix function already owned. */
export function setActiveProject(project: ProjectInfo) {
  // Save current project's view + search query + drawer-grid state
  const previous = activeProjectSignal.value;
  if (previous != null) {
    projectViews.set(previous.secret, state.view);
    projectSearches.set(previous.secret, state.search);
    // HS-6311 — grid state maps are the canonical store; we never mirror
    // them into `state` so there's nothing else to save here. Grid-mode
    // module reads them directly via getProjectGridActive / Slider helpers.
  }
  projectsStore.actions.setActive(project);
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
  projectGridColumnCount.delete(secret);
  // HS-8374 — drop every scroll-position entry whose key starts with the
  // removed project's secret so a re-added project at the same secret
  // doesn't resurrect the prior project's per-view scroll offsets.
  const prefix = `${secret}::`;
  for (const k of [...projectViewScrollPositions.keys()]) {
    if (k.startsWith(prefix)) projectViewScrollPositions.delete(k);
  }
}

/** HS-8374 — read the saved scroll position for a `(secret, view, mode)`
 *  triple. Returns 0 when no entry is recorded — that's the natural
 *  default (top of the list) for a project / view the user hasn't
 *  scrolled before. Exported so the unit test in `state.test.ts` can
 *  pin the Map shape directly. */
export function getProjectViewScrollTop(secret: string, view: string, preview: boolean): number {
  return projectViewScrollPositions.get(`${secret}::${view}::${preview ? 'preview' : 'live'}`) ?? 0;
}

/** HS-8374 — record the scroll position for a `(secret, view, mode)`
 *  triple. The caller is the ticket-list renderer; it captures the
 *  `#ticket-list` scrollTop BEFORE navigating away from a project /
 *  view pair and BEFORE the underlying signal change tears down the
 *  bindList children. */
export function setProjectViewScrollTop(secret: string, view: string, preview: boolean, scrollTop: number): void {
  projectViewScrollPositions.set(`${secret}::${view}::${preview ? 'preview' : 'live'}`, scrollTop);
}

/** HS-6311 — drawer terminal grid per-project state. The drawer grid module
 *  (src/client/drawerTerminalGrid.tsx) calls these on enter / exit / slider
 *  change. Default column count is 4 (HS-8176; pre-HS-8176 it was a 0..100
 *  slider value defaulting to 33). See docs/36 §36.4 + docs/25 §25.4. */
export function getProjectGridActive(secret: string): boolean {
  return projectGridActive.get(secret) === true;
}
export function setProjectGridActive(secret: string, value: boolean): void {
  if (value) projectGridActive.set(secret, true);
  else projectGridActive.delete(secret);
}
export function getProjectGridColumnCount(secret: string): number {
  return projectGridColumnCount.get(secret) ?? 4;
}
export function setProjectGridColumnCount(secret: string, value: number): void {
  projectGridColumnCount.set(secret, value);
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
  // HS-9045 — worker-completed but not yet merged into the target branch
  // (docs/89 §89.7). Drives the "pending merge" row indicator when completed.
  pending_integration?: boolean;
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
  /** Per-ticket sync icon as JSX (`SafeHtml`). The server delivers
   *  plugin-manifest SVG as a string on the wire; the client
   *  converts it to `SafeHtml` once at fetch time (see
   *  `ticketList.tsx::loadTickets`) so list-view consumers can
   *  render it via the standard JSX child path with `{info.icon}` —
   *  no `raw()` indirection at each render site. */
  icon?: SafeHtml;
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
  /** HS-7984 (§53 Phase 4) — when false, the §53 streaming-shell-output
   *  partial render is suppressed on both client surfaces (sidebar row
   *  preview + Commands Log live `<pre>`). Server still buffers (cheap;
   *  conditional buffering would add complexity for no payoff). Default
   *  true so the behavior is on for everyone after upgrade — the
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
  /** HS-7756 — when the user clicks the "Include `{N}` backlog items" row
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
   *  visibility of the "Include `{N}` ..." rows. Both default to 0 when
   *  no search is active or no matches exist outside the active set. */
  searchExtraCounts: { backlog: number; archive: number };
  /** HS-8337 — list-layout pagination window size. The next `loadTickets`
   *  fetch in list layout requests `limit = listLimit + 1` rows and trims
   *  the extra to derive `hasMoreTickets`. Grows by `LIST_PAGE_SIZE` (100)
   *  each time the user clicks Load More; resets to the page size on any
   *  scope change (view / search / sort / layout). Ignored in column
   *  layout and on the custom-view / preview paths. */
  listLimit: number;
  /** HS-8337 — true after the most recent list-layout fetch when the
   *  server returned the full `limit + 1` rows. Drives visibility of the
   *  Load More button at the bottom of the list. */
  hasMoreTickets: boolean;
}

export const state: AppState = {
  // HS-8239 (2026-05-11) — `tickets` is installed below as a getter+setter
  // that delegates to `ticketsStore`. The dummy `[]` here is required by
  // the type-literal shape but immediately overwritten by the
  // `Object.defineProperty` call after the object is created.
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
  // HS-8327 (2026-05-11) — `view` / `search` / `includeBacklogInSearch` /
  // `includeArchiveInSearch` are installed below as getter+setter
  // delegates to `ticketsStore.filter`. The dummy values here are
  // required by the type-literal shape but immediately overwritten by
  // the `Object.defineProperty` calls after the object is created.
  view: 'all',
  // HS-8490 (2026-05-22) — initial layout flipped from `'list'` to
  // `'columns'` so new installs default to the column-board view.
  // `loadSettings` overrides this with the persisted `layout` value
  // when one exists (`'list'` OR `'columns'`), so existing users
  // who had explicitly chosen list view keep seeing list view. Only
  // users with no persisted choice (genuinely new installs OR new
  // projects on existing installs) hit this new default. The
  // `canUseColumnView` gate further falls back to list view for
  // the views that don't support columns (completed / verified /
  // trash / backlog / archive) regardless of this default.
  layout: 'columns',
  sortBy: 'created',
  sortDir: 'desc',
  search: '',
  settings: { ...DEFAULT_SETTINGS },
  backupPreview: null,
  includeBacklogInSearch: false,
  includeArchiveInSearch: false,
  viewModeBeforeSearchInclude: null,
  searchExtraCounts: { backlog: 0, archive: 0 },
  listLimit: 100,
  hasMoreTickets: false,
};

/** HS-8337 — page size for list-layout pagination. Initial fetch and each
 *  Load More click both grow `state.listLimit` by this amount. Kept in
 *  sync with the literal initializer on `state.listLimit` above. */
export const LIST_PAGE_SIZE = 100;

// HS-8239 (2026-05-11) — §61 Phase 2 data-source flip. `state.tickets` is
// installed here as a getter+setter that delegates to the kerf
// `ticketsStore`. All ~82 read sites across 20 client files keep working
// unchanged — the getter returns the live readonly array (cast to
// `Ticket[]` to keep the AppState interface byte-identical so the
// callsite types don't all need to be touched in this atomic flip).
// All 5 write sites (`ticketList.tsx::loadTickets` × 4 + the inline-edit
// remove path in `ticketRow.tsx`) go through the setter which calls
// `ticketsStore.actions.setTickets(value)`. No mixed-source state — the
// store is the single source of truth.
//
// Per the FEEDBACK NEEDED design call on HS-8239 (option b): the
// `bindList` rewrite of `renderTicketList` + the filter-state migration
// are deferred to follow-up tickets (HS-XXXX / HS-XXXX). Those follow-
// ups can land independently because the data source is already
// unified — they're orthogonal view-layer + filter-state changes, not
// source-of-truth changes.
Object.defineProperty(state, 'tickets', {
  configurable: true,
  enumerable: true,
  get(): Ticket[] {
    // The store keeps `tickets: readonly Ticket[]`; cast back to
    // `Ticket[]` so the AppState interface contract (`tickets: Ticket[]`)
    // is satisfied for the 82 callsites. The cast is safe because the
    // store always replaces the array wholesale via `setTickets` — no
    // callsite mutates in place.
    return ticketsStore.state.value.tickets as Ticket[];
  },
  set(value: readonly Ticket[]): void {
    ticketsStore.actions.setTickets(value);
  },
});

// HS-8327 (2026-05-11) — §61 Phase 2 filter-state delegate flip. Same
// pattern as the HS-8239 `state.tickets` delegate above. The four
// filter-state fields (`view` / `search` / `includeBacklogInSearch` /
// `includeArchiveInSearch`) become getter+setter delegates that
// read/write through `ticketsStore.state.value.filter` /
// `ticketsStore.actions.patchFilter({...})`. All ~110 read sites across
// ~12 client files keep working unchanged via the getters. The ~24
// production write sites land in `patchFilter` under the hood. No
// mixed-source state — the store is the single source of truth for the
// filter slice.
//
// Per the HS-8327 ticket description, extending the `filteredTickets`
// computed body with view / includeBacklog / includeArchive filter
// logic is deferred to HS-8326 (where it has a real consumer via
// `bindList`). Extending the computed without a consumer would just
// create an unused alternate view; HS-8326's bindList wiring is what
// makes the extended computed body load-bearing.
Object.defineProperty(state, 'view', {
  configurable: true,
  enumerable: true,
  get(): string { return ticketsStore.state.value.filter.view; },
  set(value: string): void { ticketsStore.actions.patchFilter({ view: value }); },
});
Object.defineProperty(state, 'search', {
  configurable: true,
  enumerable: true,
  get(): string { return ticketsStore.state.value.filter.search; },
  set(value: string): void { ticketsStore.actions.patchFilter({ search: value }); },
});
Object.defineProperty(state, 'includeBacklogInSearch', {
  configurable: true,
  enumerable: true,
  get(): boolean { return ticketsStore.state.value.filter.includeBacklogInSearch; },
  set(value: boolean): void { ticketsStore.actions.patchFilter({ includeBacklogInSearch: value }); },
});
Object.defineProperty(state, 'includeArchiveInSearch', {
  configurable: true,
  enumerable: true,
  get(): boolean { return ticketsStore.state.value.filter.includeArchiveInSearch; },
  set(value: boolean): void { ticketsStore.actions.patchFilter({ includeArchiveInSearch: value }); },
});

const LUCIDE_14 = {
  xmlns: 'http://www.w3.org/2000/svg',
  width: '14',
  height: '14',
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '2',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
} as const;

const PRIORITY_ICONS: Record<string, SafeHtml> = {
  highest: <svg {...LUCIDE_14}><path d="m7 11 5-5 5 5"/><path d="m7 17 5-5 5 5"/></svg>,
  high: <svg {...LUCIDE_14}><path d="m18 15-6-6-6 6"/></svg>,
  default: <svg {...LUCIDE_14}><path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/></svg>,
  low: <svg {...LUCIDE_14}><path d="m6 9 6 6 6-6"/></svg>,
  lowest: <svg {...LUCIDE_14}><path d="m7 7 5 5 5-5"/><path d="m7 13 5 5 5-5"/></svg>,
};

const PRIORITY_COLORS: Record<string, string> = {
  highest: '#ef4444',
  high: '#f97316',
  default: '#6b7280',
  low: '#3b82f6',
  lowest: '#94a3b8',
};

const CHECK_CHECK_SVG: SafeHtml = <svg {...LUCIDE_14}><path d="M18 6 7 17l-5-5"/><path d="m22 10-7.5 7.5L13 16"/></svg>;

const STATUS_ICONS: Record<string, string | SafeHtml> = {
  not_started: '\u25CB',
  started: '\u25D4',
  completed: '\u2713',
  verified: CHECK_CHECK_SVG,
  backlog: '\u25A1',
  archive: '\u25A0',
};

export const VERIFIED_SVG: SafeHtml = CHECK_CHECK_SVG;

export function getCategoryColor(cat: string): string {
  const def = state.categories.find(c => c.id === cat);
  return def?.color ?? '#6b7280';
}

export function getCategoryLabel(cat: string): string {
  const def = state.categories.find(c => c.id === cat);
  return def?.shortLabel ?? cat.slice(0, 3).toUpperCase();
}

export function getPriorityIcon(pri: string): string | SafeHtml {
  return PRIORITY_ICONS[pri] ?? '—';
}

export function getPriorityColor(pri: string): string {
  return PRIORITY_COLORS[pri] || '#6b7280';
}

export function getStatusIcon(status: string): string | SafeHtml {
  return STATUS_ICONS[status] ?? '\u25CB';
}

/**
 * HS-7998 — true when toggling up-next on a ticket with this status
 * should ALSO flip the status back to `not_started`. Out-of-active-
 * workflow statuses — `completed`, `verified`, `backlog`, `archive` —
 * stay invisible from the default Up Next column unless the user
 * explicitly puts them back in motion. Adding such a ticket to Up Next
 * implies the user wants to work on it, so we reset the status as part
 * of the same toggle. Pre-fix this only fired for `completed` /
 * `verified`; backlog / archive items would star themselves but stay
 * invisible from Up Next, which the user filed as a bug.
 *
 * Pure for unit-testability — the three `toggleUpNext` callsites
 * (`ticketRow.tsx`, `app.tsx::bindDetailUpNext`, `actions.ts` batch)
 * import this rather than each maintaining their own status set.
 */
export function shouldResetStatusOnUpNext(status: string): boolean {
  return status === 'completed' || status === 'verified' || status === 'backlog' || status === 'archive';
}

// --- Canonical priority and status items (shared across batch, contextMenu, detail, ticketListState) ---

// HS-8642 — `value` is typed as the priority / status literal union (not bare
// `string`) so the detail-panel dropdowns can build a typed `UpdateTicketReq`
// straight from `p.value` / `s.value` without a cast. Every consumer reads
// these as strings, so the narrower type is a safe, no-ripple improvement.
export const PRIORITY_ITEMS: { key: string; value: TicketPriority; label: string }[] = [
  { key: '1', value: 'highest', label: 'Highest' },
  { key: '2', value: 'high', label: 'High' },
  { key: '3', value: 'default', label: 'Default' },
  { key: '4', value: 'low', label: 'Low' },
  { key: '5', value: 'lowest', label: 'Lowest' },
];

export const STATUS_ITEMS: { key: string; value: TicketStatus; label: string }[] = [
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
  const { getTags } = await import('../api/index.js');
  try { allKnownTags = await getTags(); } catch { /* use cached */ }
}

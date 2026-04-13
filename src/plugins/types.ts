import type { Ticket, TicketPriority, TicketStatus } from '../types.js';

// --- Plugin manifest ---

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  /** Entry point relative to the plugin directory (default: index.js) */
  entry?: string;
  /** Small SVG icon for the plugin (inline SVG string, shown on synced tickets) */
  icon?: string;
  /** Plugin preferences schema — UI renders controls based on this */
  preferences?: PluginPreference[];
  /** Config dialog layout — groups, dividers, dynamic elements. If omitted, preferences are shown flat. */
  configLayout?: ConfigLayoutItem[];
}

export interface PluginPreference {
  key: string;
  label: string;
  /** string, boolean, number, select (legacy alias for dropdown), dropdown, combo (dropdown + custom entry) */
  type: 'string' | 'boolean' | 'number' | 'select' | 'dropdown' | 'combo';
  default?: string | boolean | number;
  description?: string;
  required?: boolean;
  secret?: boolean;
  /** Whether this setting is global or per-project. Default: 'project'. */
  scope?: 'global' | 'project';
  options?: { value: string; label: string }[];
}

/** Predefined label color tones. The actual CSS color is bound by the host. */
export type ConfigLabelColor = 'default' | 'success' | 'error' | 'warning' | 'transient';

/** Items in the config dialog layout. */
export type ConfigLayoutItem =
  | { type: 'preference'; key: string }
  | { type: 'divider' }
  | { type: 'spacer' }
  | { type: 'label'; id: string; text: string; color?: ConfigLabelColor }
  | { type: 'button'; id: string; label: string; action: string; icon?: string; style?: string }
  | { type: 'group'; title: string; collapsed?: boolean; items: ConfigLayoutItem[] };

// --- Plugin UI extensions ---

/** Where a UI element can be placed. */
export type PluginUILocation =
  | 'toolbar'                // Header toolbar (between glassbox and print buttons)
  | 'status_bar'             // Footer status bar (before command log drawer button)
  | 'sidebar_actions_top'    // Sidebar, before first action
  | 'sidebar_actions_bottom' // Sidebar, after last action
  | 'detail_top'             // Detail panel, above fields (per selected ticket)
  | 'detail_bottom'          // Detail panel, below attachments (per selected ticket)
  | 'batch_menu'             // Batch toolbar "..." menu
  | 'context_menu';          // Right-click ticket context menu

/** Base fields shared by all UI element types. */
interface PluginUIBase {
  /** Unique ID for this element within the plugin. */
  id: string;
  /** Where to render this element. */
  location: PluginUILocation;
  /** Only show for synced tickets (detail/context locations). Default: false. */
  syncedOnly?: boolean;
}

/** A clickable button. */
export interface PluginUIButton extends PluginUIBase {
  type: 'button';
  label?: string;
  icon?: string;
  title?: string;
  color?: string;
  style?: 'default' | 'primary' | 'danger';
  /** Action ID sent to the plugin when clicked. */
  action: string;
}

/** A toggle button (two visual states). */
export interface PluginUIToggle extends PluginUIBase {
  type: 'toggle';
  on: { label?: string; icon?: string; title?: string; color?: string; style?: string };
  off: { label?: string; icon?: string; title?: string; color?: string; style?: string };
  /** Action ID sent to the plugin when toggled. */
  action: string;
  /** Setting key to read/write the toggle state. */
  stateKey?: string;
}

/** A labeled switch. */
export interface PluginUISwitch extends PluginUIBase {
  type: 'switch';
  onLabel: string;
  offLabel: string;
  action: string;
  stateKey?: string;
}

/** A link that opens an external URL. */
export interface PluginUILink extends PluginUIBase {
  type: 'link';
  url: string;
  label?: string;
  icon?: string;
  title?: string;
}

/** A segmented control (multiple segments, configurable selection mode). */
export interface PluginUISegmentedControl extends PluginUIBase {
  type: 'segmented_control';
  segments: { id: string; label?: string; icon?: string; title?: string }[];
  /** How many segments can/must be selected. */
  selectionMode: 'zero_or_one' | 'exactly_one' | 'zero_or_more' | 'one_or_more';
  action: string;
  stateKey?: string;
}

export type PluginUIElement =
  | PluginUIButton
  | PluginUIToggle
  | PluginUISwitch
  | PluginUILink
  | PluginUISegmentedControl;

// --- Plugin lifecycle ---

export interface HotSheetPlugin {
  /** Called when the plugin is loaded. Return a TicketingBackend if the plugin provides one. */
  activate(context: PluginContext): Promise<TicketingBackend | undefined>;
  /** Called when the plugin is unloaded or disabled. */
  deactivate?(): Promise<void>;
  /** Called when a UI element action is triggered. Return value is sent back to the client. */
  onAction?(actionId: string, context: { ticketIds?: number[]; value?: unknown }): Promise<unknown>;
  /** Validate a config field value. Return null if valid, or a message. */
  validateField?(key: string, value: string): Promise<FieldValidation | null>;
}

export interface FieldValidation {
  status: 'error' | 'warning' | 'success';
  message: string;
}

/** UI elements registered by plugins at activation time. */
export interface PluginUIRegistration {
  pluginId: string;
  elements: PluginUIElement[];
}

export interface PluginContext {
  /** Plugin's own configuration values (from preferences + user overrides) */
  config: Record<string, unknown>;
  /** Log a message attributed to this plugin */
  log(level: 'info' | 'warn' | 'error', message: string): void;
  /** Read a setting from the plugin's config store */
  getSetting(key: string): Promise<string | null>;
  /** Write a setting to the plugin's config store */
  setSetting(key: string, value: string): Promise<void>;
  /** Register UI elements for this plugin. */
  registerUI(elements: PluginUIElement[]): void;
  /** Dynamically update a config layout label's text and optional color. */
  updateConfigLabel(labelId: string, text: string, color?: ConfigLabelColor): void;
}

// --- Ticketing backend interface ---

export interface TicketingBackend {
  /** Unique backend identifier (matches the plugin id) */
  id: string;
  /** Human-readable name (e.g. "GitHub Issues") */
  name: string;

  /** What this backend supports */
  capabilities: BackendCapabilities;

  /** Map between local and remote field values */
  fieldMappings: FieldMappings;

  // --- CRUD ---

  /** Create a ticket in the remote system. Returns the remote ID. */
  createRemote(ticket: Ticket): Promise<string>;
  /** Update fields on a remote ticket. */
  updateRemote(remoteId: string, changes: Partial<RemoteTicketFields>): Promise<void>;
  /** Delete or close a ticket in the remote system. */
  deleteRemote(remoteId: string): Promise<void>;

  // --- Sync ---

  /** Fetch tickets modified since the given date. Returns mapped ticket data + remote IDs. */
  pullChanges(since: Date | null): Promise<RemoteChange[]>;
  /** Get the current state of a single remote ticket (for conflict resolution). */
  getRemoteTicket?(remoteId: string): Promise<RemoteTicketFields | null>;

  // --- Status ---

  /** Check if the backend is connected and authenticated. */
  checkConnection(): Promise<{ connected: boolean; error?: string }>;

  /** Get the URL to view a ticket in the remote system (for clickable links). */
  getRemoteUrl?(remoteId: string): string | null;

  /** Called when a new ticket is created locally. Plugin decides whether to sync it.
   *  Return true to create the ticket remotely (sync record will be established). */
  shouldAutoSync?(ticket: Ticket): boolean;

  /** Upload an attachment file and return its public URL. Returns null if uploads not configured. */
  uploadAttachment?(filename: string, content: Buffer, mimeType: string): Promise<string | null>;

  // --- Comments (notes sync) ---

  /** Fetch comments for a remote ticket. */
  getComments?(remoteId: string): Promise<RemoteComment[]>;
  /** Create a comment on a remote ticket. Returns the remote comment ID. */
  createComment?(remoteId: string, text: string): Promise<string>;
  /** Update a comment on a remote ticket. */
  updateComment?(remoteId: string, commentId: string, text: string): Promise<void>;
  /** Delete a comment from a remote ticket. */
  deleteComment?(remoteId: string, commentId: string): Promise<void>;
}

export interface RemoteComment {
  id: string;
  text: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface BackendCapabilities {
  /** Can create new tickets remotely */
  create: boolean;
  /** Can update existing tickets remotely */
  update: boolean;
  /** Can delete/close tickets remotely */
  delete: boolean;
  /** Supports incremental pull via modified-since */
  incrementalPull: boolean;
  /** Which fields can be synced */
  syncableFields: (keyof RemoteTicketFields)[];
  /** Supports comment sync (notes ↔ comments) */
  comments?: boolean;
}

// --- Field mappings ---

export interface FieldMappings {
  /** Map local category IDs to remote values */
  category: FieldMap;
  /** Map local priority values to remote values */
  priority: FieldMap<TicketPriority>;
  /** Map local status values to remote values */
  status: FieldMap<TicketStatus>;
}

export interface FieldMap<T extends string = string> {
  /** Local value → remote value */
  toRemote: Record<string, string>;
  /** Remote value → local value */
  toLocal: Record<string, T>;
}

// --- Remote ticket representation ---

export interface RemoteTicketFields {
  title: string;
  details: string;
  category: string;
  priority: string;
  status: string;
  tags: string[];
  up_next: boolean;
}

export interface RemoteChange {
  /** The remote system's unique ID for this ticket */
  remoteId: string;
  /** The remote ticket data (already mapped to local field values) */
  fields: Partial<RemoteTicketFields>;
  /** When this change was made remotely */
  remoteUpdatedAt: Date;
  /** Whether the remote ticket was deleted/closed */
  deleted?: boolean;
}

// --- Sync state (DB records) ---

export interface TicketSyncRecord {
  id: number;
  ticket_id: number;
  plugin_id: string;
  remote_id: string;
  last_synced_at: string;
  remote_updated_at: string | null;
  local_updated_at: string;
  sync_status: SyncStatus;
  conflict_data: string | null;
}

export type SyncStatus = 'synced' | 'pending_push' | 'pending_pull' | 'conflict' | 'error';

export interface SyncOutboxEntry {
  id: number;
  ticket_id: number;
  plugin_id: string;
  action: 'create' | 'update' | 'delete';
  field_changes: string;
  created_at: string;
  attempts: number;
  last_error: string | null;
}

// --- Loaded plugin state (runtime) ---

export interface LoadedPlugin {
  manifest: PluginManifest;
  path: string;
  instance: HotSheetPlugin;
  backend: TicketingBackend | null;
  enabled: boolean;
  error: string | null;
}

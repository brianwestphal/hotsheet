# Hot Sheet Plugin Development Guide

This guide is designed for AI coding assistants (Claude, Copilot, etc.) and human developers. It provides everything needed to build a Hot Sheet plugin from scratch.

## Plugin Structure

A plugin is a directory in `~/.hotsheet/plugins/` containing:

```
my-plugin/
  manifest.json    # Plugin metadata, preferences, and UI layout
  index.js         # Entry point (ESM module)
```

Or if using TypeScript:

```
my-plugin/
  manifest.json
  src/
    types.ts       # Standalone type definitions (copy from below)
    index.ts       # Entry point
  tsconfig.json
```

Build the TypeScript to `index.js` in the plugin root.

## Manifest Format

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "description": "What this plugin does",
  "author": "Author Name",
  "entry": "index.js",
  "icon": "<svg ...>...</svg>",
  "preferences": [ ... ],
  "configLayout": [ ... ]
}
```

### Required Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique plugin identifier (e.g. `linear-issues`) |
| `name` | string | Human-readable display name |
| `version` | string | Semver version |

### Optional Fields

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | Short description shown in plugin list |
| `author` | string | Author name |
| `entry` | string | Entry point filename (default: `index.js`) |
| `icon` | string | Inline SVG string (14x14 viewBox recommended, shown on synced tickets) |
| `preferences` | array | Configurable settings (see below) |
| `configLayout` | array | Config dialog layout (see below) |

## Preferences

Each preference defines a configurable setting:

```json
{
  "key": "api_token",
  "label": "API Token",
  "type": "string",
  "required": true,
  "secret": true,
  "scope": "global",
  "description": "Your personal API token"
}
```

### Preference Fields

| Field | Type | Values | Description |
|-------|------|--------|-------------|
| `key` | string | | Setting identifier |
| `label` | string | | Display label |
| `type` | string | `string`, `boolean`, `number`, `select`, `dropdown`, `combo` | Input type |
| `default` | any | | Default value |
| `description` | string | | Help text shown below the label |
| `required` | boolean | | Shows asterisk, affects "Needs Configuration" status |
| `secret` | boolean | | Masks the input (password field) |
| `scope` | string | `global`, `project` | `global` = shared across projects (stored in `~/.hotsheet/plugin-config.json`). `project` = per-project (stored in project DB). Default: `project` |
| `options` | array | `[{ value, label }]` | For `select`, `dropdown`, and `combo` types |

**Type details:**
- `string` — text input (password if `secret: true`)
- `boolean` — checkbox
- `number` — numeric input
- `select` / `dropdown` — dropdown with predefined choices
- `combo` — dropdown with predefined choices AND free-text entry

## Config Layout

The `configLayout` array controls how the config dialog is structured. If omitted, preferences are shown in a flat list.

```json
"configLayout": [
  { "type": "preference", "key": "api_token" },
  { "type": "divider" },
  { "type": "preference", "key": "workspace" },
  { "type": "preference", "key": "project" },
  { "type": "spacer" },
  { "type": "label", "id": "connection-status", "text": "Not tested" },
  { "type": "button", "id": "test-btn", "label": "Test Connection", "action": "test_connection" },
  { "type": "group", "title": "Advanced", "collapsed": true, "items": [
    { "type": "preference", "key": "custom_field_mapping" }
  ]}
]
```

### Layout Item Types

| Type | Fields | Description |
|------|--------|-------------|
| `preference` | `key` | Renders the preference input for the given key |
| `divider` | | Horizontal line |
| `spacer` | | Vertical gap (8px) |
| `label` | `id`, `text`, `color?` | Dynamic text label. `color` is one of `default`, `success`, `error`, `warning`, `transient`. Update via `context.updateConfigLabel` |
| `button` | `id`, `label`, `action`, `icon?`, `style?` | Clickable button that triggers `onAction` |
| `group` | `title`, `collapsed?`, `items` | Collapsible group containing other layout items |

## Plugin Entry Point

The entry point must export an `activate` function. It can optionally export `onAction` and `validateField`.

```typescript
import type { PluginContext, TicketingBackend } from './types.js';

let context: PluginContext;

export async function activate(ctx: PluginContext): Promise<TicketingBackend | void> {
  context = ctx;

  // Read settings
  const token = await ctx.getSetting('api_token');
  const workspace = await ctx.getSetting('workspace');

  // Register UI elements (toolbar buttons, etc.)
  ctx.registerUI([
    {
      id: 'sync-button',
      type: 'button',
      location: 'toolbar',
      icon: '<svg ...>...</svg>',
      title: 'Sync',
      action: 'sync',
    },
  ]);

  // Return a TicketingBackend if this plugin syncs with an external system
  // Return void/undefined if this plugin doesn't sync tickets
  return {
    id: 'my-plugin',
    name: 'My Plugin',
    capabilities: { create: true, update: true, delete: true, incrementalPull: true, comments: true, syncableFields: ['title', 'details', 'category', 'priority', 'status', 'tags', 'up_next'] },
    fieldMappings: { category: { toRemote: {}, toLocal: {} }, priority: { toRemote: {}, toLocal: {} }, status: { toRemote: {}, toLocal: {} } },
    // ... implement methods below
  };
}

export async function onAction(actionId: string, actionContext: { ticketIds?: number[]; value?: unknown }): Promise<unknown> {
  if (actionId === 'sync') return { redirect: 'sync' };
  if (actionId === 'test_connection') {
    // test and update label (third arg is one of: default | success | error | warning | transient)
    context.updateConfigLabel('connection-status', 'Connected', 'success');
    return { connected: true };
  }
  return null;
}

export async function validateField(key: string, value: string): Promise<{ status: string; message: string } | null> {
  if (key === 'api_token' && !value) return { status: 'error', message: 'Required' };
  return null;
}
```

## PluginContext API

The `context` object passed to `activate`:

| Method | Description |
|--------|-------------|
| `getSetting(key)` | Read a preference value (respects scope: global vs project) |
| `setSetting(key, value)` | Write a preference value |
| `log(level, message)` | Log attributed to this plugin (`'info'`, `'warn'`, `'error'`) |
| `registerUI(elements)` | Register UI elements (toolbar buttons, etc.) |
| `updateConfigLabel(labelId, text, color?)` | Dynamically update a label in the config dialog. `color` is `default` \| `success` \| `error` \| `warning` \| `transient` |

## UI Extension Points

Plugins can register UI elements at these locations:

| Location | Scope | Description |
|----------|-------|-------------|
| `toolbar` | Project | Header toolbar |
| `status_bar` | Project | Footer status bar |
| `sidebar_actions_top` | Project | Sidebar, before first action |
| `sidebar_actions_bottom` | Project | Sidebar, after last action |
| `detail_top` | Ticket | Detail panel, above fields |
| `detail_bottom` | Ticket | Detail panel, below attachments |
| `batch_menu` | Selection | Batch toolbar "..." menu |
| `context_menu` | Selection | Right-click ticket context menu |

### Element Types

**Button:**
```javascript
{ id: 'my-btn', type: 'button', location: 'toolbar', label: 'Click Me', icon: '<svg...>', title: 'Tooltip', action: 'my_action', style: 'default' | 'primary' | 'danger' }
```

**Toggle, Switch, Link, Segmented Control** — see `src/plugins/types.ts` for full definitions.

When a user clicks a button, the app calls `POST /api/plugins/:id/action` with `{ actionId }`, which invokes the plugin's `onAction` handler. Return `{ redirect: 'sync' }` to trigger a sync operation, or return `{ message: '...' }` to show a brief toast notification to the user.

**Location rendering:** Toolbar buttons show icon only (compact). All other locations (status_bar, sidebar, detail, context_menu, batch_menu) show icon + label together. `button` and `link` types are rendered; `toggle`, `switch`, and `segmented_control` are declared but not yet rendered.

---

# Part 1: Building a Ticketing System Plugin

This section covers building a plugin that syncs tickets with an external system (GitHub Issues, Linear, Jira, Trello, etc.).

## TicketingBackend Interface

Return this from `activate()` to enable bidirectional sync:

```typescript
interface TicketingBackend {
  id: string;          // Must match the plugin's manifest id
  name: string;        // Display name (e.g. "Linear")

  capabilities: {
    create: boolean;         // Can create tickets remotely
    update: boolean;         // Can update tickets remotely
    delete: boolean;         // Can delete/close tickets remotely
    incrementalPull: boolean; // Supports pulling changes since a date
    comments?: boolean;       // Supports comment/note sync
    syncableFields: ('title' | 'details' | 'category' | 'priority' | 'status' | 'tags' | 'up_next')[];
  };

  fieldMappings: {
    category: { toRemote: Record<string, string>, toLocal: Record<string, string> },
    priority: { toRemote: Record<string, string>, toLocal: Record<string, string> },
    status:   { toRemote: Record<string, string>, toLocal: Record<string, string> },
  };

  // Required methods:
  createRemote(ticket: Ticket): Promise<string>;  // Returns remote ID
  updateRemote(remoteId: string, changes: Partial<RemoteTicketFields>): Promise<void>;
  deleteRemote(remoteId: string): Promise<void>;
  pullChanges(since: Date | null): Promise<RemoteChange[]>;
  checkConnection(): Promise<{ connected: boolean; error?: string }>;

  // Optional methods:
  getRemoteTicket?(remoteId: string): Promise<RemoteTicketFields | null>;
  getRemoteUrl?(remoteId: string): string | null;  // URL to view ticket remotely
  shouldAutoSync?(ticket: Ticket): boolean;  // Auto-push new tickets?
  getComments?(remoteId: string): Promise<RemoteComment[]>;
  createComment?(remoteId: string, text: string): Promise<string>;
  updateComment?(remoteId: string, commentId: string, text: string): Promise<void>;
  deleteComment?(remoteId: string, commentId: string): Promise<void>;
  uploadAttachment?(filename: string, content: Buffer, mimeType: string): Promise<string | null>;
}
```

## How Sync Works

The sync engine handles the complexity. Your plugin just needs to implement the interface methods.

### Pull (remote -> local)

1. Engine calls `pullChanges(since)` — return all issues modified since the date
2. For each `RemoteChange`, the engine checks if a local ticket is already linked
3. **New remote ticket**: creates a local ticket
4. **Existing linked ticket**: compares timestamps, applies remote changes if only remote modified
5. **Both modified**: creates a conflict record (user resolves in UI)

### Push (local -> remote)

1. Engine compares each synced ticket's `updated_at` with the sync record's `local_updated_at`
2. If the local ticket was modified since last sync, calls `updateRemote(remoteId, allFields)` with the full current field values
3. Create/delete operations are tracked via an outbox queue

### Comments

If `capabilities.comments` is true and comment methods are implemented, the sync engine runs a three-way merge using `last_synced_text` in the `note_sync` table:

**Create (bidirectional):**
1. New remote comments (unmapped) → create local notes. Text-based dedup: if a local note already has identical text, it's linked instead of duplicated.
2. New local notes (unmapped) → call `createComment(remoteId, text)`. Text-based dedup applies in reverse.

**Edit (bidirectional):**
3. For each existing mapping, compares current local text and remote text against the `last_synced_text` baseline.
4. Only local changed → calls `updateComment(remoteId, commentId, newText)`.
5. Only remote changed → updates the local note text.
6. Both changed → push-wins (local overwrites remote via `updateComment`).

**Delete (bidirectional):**
7. Local note deleted (mapping exists, note gone) → calls `deleteComment(remoteId, commentId)`.
8. Remote comment deleted (mapping exists, comment gone) → removes the local note.

Attachment mappings (note IDs with `att_` prefix) are skipped by the comment sync.

### Attachments

If `uploadAttachment` is implemented:
1. Engine reads local attachments for each synced ticket
2. Calls `uploadAttachment(filename, content, mimeType)` → returns a URL
3. Posts a markdown comment on the remote issue with the file link
4. Returned URLs should be permanent (not short-lived tokens) — the host may cache or proxy them

## Field Mappings

Map between Hot Sheet's field values and the remote system's values.

**Hot Sheet ticket fields:**
- `category`: `issue`, `bug`, `feature`, `requirement_change`, `task`, `investigation` (customizable)
- `priority`: `highest`, `high`, `default`, `low`, `lowest`
- `status`: `not_started`, `started`, `completed`, `verified`, `backlog`, `archive`
- `tags`: JSON array of strings
- `up_next`: boolean

**Example mapping for Linear:**
```typescript
fieldMappings: {
  category: {
    toRemote: { bug: 'Bug', feature: 'Feature', task: 'Task', issue: 'Issue' },
    toLocal: { 'Bug': 'bug', 'Feature': 'feature', 'Task': 'task', 'Issue': 'issue' },
  },
  priority: {
    toRemote: { highest: '1', high: '2', default: '3', low: '4', lowest: '0' },
    toLocal: { '1': 'highest', '2': 'high', '3': 'default', '4': 'low', '0': 'lowest' },
  },
  status: {
    toRemote: { not_started: 'Todo', started: 'In Progress', completed: 'Done', verified: 'Done' },
    toLocal: { 'Todo': 'not_started', 'In Progress': 'started', 'Done': 'completed', 'Backlog': 'backlog' },
  },
}
```

## RemoteChange Format

`pullChanges` must return an array of:

```typescript
{
  remoteId: string;        // The remote system's ID for this ticket
  fields: {                // Mapped to Hot Sheet field values (use toLocal mappings)
    title: string;
    details: string;
    category: string;      // Already mapped to local value
    priority: string;      // Already mapped to local value
    status: string;        // Already mapped to local value
    tags: string[];
    up_next: boolean;
  };
  remoteUpdatedAt: Date;   // When the remote ticket was last modified
  deleted?: boolean;       // True if the remote ticket was deleted
}
```

## Complete Example: Linear Plugin Skeleton

```typescript
import type { PluginContext, RemoteChange, RemoteTicketFields, Ticket, TicketingBackend } from './types.js';

let context: PluginContext;

export async function activate(ctx: PluginContext): Promise<TicketingBackend> {
  context = ctx;
  const apiKey = await ctx.getSetting('api_key');
  const teamId = await ctx.getSetting('team_id');

  ctx.registerUI([
    { id: 'sync-btn', type: 'button', location: 'toolbar', icon: '<svg>...</svg>', title: 'Sync with Linear', action: 'sync' },
  ]);

  async function linearFetch(query: string, variables?: Record<string, unknown>) {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': apiKey ?? '' },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) throw new Error(`Linear API error: ${res.status}`);
    return res.json();
  }

  return {
    id: 'linear',
    name: 'Linear',
    capabilities: {
      create: true, update: true, delete: false,
      incrementalPull: true, comments: true,
      syncableFields: ['title', 'details', 'category', 'priority', 'status', 'tags', 'up_next'],
    },
    fieldMappings: {
      category: { toRemote: { bug: 'Bug', feature: 'Feature' }, toLocal: { 'Bug': 'bug', 'Feature': 'feature' } },
      priority: { toRemote: { highest: '1', high: '2', default: '3', low: '4', lowest: '0' }, toLocal: { '1': 'highest', '2': 'high', '3': 'default', '4': 'low', '0': 'lowest' } },
      status: { toRemote: { not_started: 'Todo', started: 'In Progress', completed: 'Done' }, toLocal: { 'Todo': 'not_started', 'In Progress': 'started', 'Done': 'completed' } },
    },

    async createRemote(ticket) {
      const data = await linearFetch(`mutation { issueCreate(input: { teamId: "${teamId}", title: "${ticket.title}", description: "${ticket.details}" }) { issue { id } } }`);
      return data.data.issueCreate.issue.id;
    },

    async updateRemote(remoteId, changes) {
      const input: Record<string, string> = {};
      if (changes.title) input.title = changes.title;
      if (changes.details) input.description = changes.details;
      // ... map other fields
      await linearFetch(`mutation { issueUpdate(id: "${remoteId}", input: ${JSON.stringify(input)}) { issue { id } } }`);
    },

    async deleteRemote(remoteId) {
      await linearFetch(`mutation { issueArchive(id: "${remoteId}") { success } }`);
    },

    async pullChanges(since) {
      const filter = since ? `updatedAt: { gte: "${since.toISOString()}" }` : '';
      const data = await linearFetch(`{ issues(filter: { team: { id: { eq: "${teamId}" } }, ${filter} }) { nodes { id title description state { name } priority updatedAt labels { nodes { name } } } } }`);
      return data.data.issues.nodes.map((issue: any) => ({
        remoteId: issue.id,
        fields: {
          title: issue.title,
          details: issue.description ?? '',
          status: this.fieldMappings.status.toLocal[issue.state.name] ?? 'not_started',
          priority: this.fieldMappings.priority.toLocal[String(issue.priority)] ?? 'default',
          category: 'issue',
          tags: issue.labels.nodes.map((l: any) => l.name),
          up_next: false,
        },
        remoteUpdatedAt: new Date(issue.updatedAt),
      }));
    },

    async checkConnection() {
      try {
        await linearFetch('{ viewer { id } }');
        return { connected: true };
      } catch (e) {
        return { connected: false, error: (e as Error).message };
      }
    },

    getRemoteUrl(remoteId) {
      return `https://linear.app/issue/${remoteId}`;
    },
  };
}

export async function onAction(actionId: string) {
  if (actionId === 'sync') return { redirect: 'sync' };
  if (actionId === 'test_connection') {
    // handled by checkConnection via the status endpoint
    return null;
  }
  return null;
}
```

---

# Part 2: Building Non-Ticketing Plugins

Plugins don't have to sync with external systems. They can add toolbar buttons, custom actions, sidebar widgets, or other functionality. Just return `void` from `activate()` instead of a `TicketingBackend`.

## Examples of Non-Ticketing Plugins

- **Time tracker** — start/stop timer on tickets, log hours
- **Export plugin** — export tickets as CSV, PDF, or custom format
- **Notification plugin** — send Slack/Discord/email notifications on ticket changes
- **AI assistant** — auto-categorize or auto-prioritize tickets
- **Custom views** — add computed sidebar stats or dashboards
- **Integration bridge** — post to webhooks, trigger CI/CD pipelines

## Minimal Non-Ticketing Plugin

```typescript
import type { PluginContext } from './types.js';

export async function activate(context: PluginContext): Promise<void> {
  context.registerUI([
    {
      id: 'export-csv',
      type: 'button',
      location: 'toolbar',
      label: 'Export CSV',
      icon: '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>',
      action: 'export',
    },
  ]);
}

export async function onAction(actionId: string, context: { ticketIds?: number[] }): Promise<unknown> {
  if (actionId === 'export') {
    // The action runs on the server — you have full Node.js access
    // Return data to the client or trigger side effects
    return { message: 'Export complete', url: '/path/to/exported/file.csv' };
  }
  return null;
}
```

## Standalone Types File

Copy this into your plugin's `src/types.ts` to build independently from the Hot Sheet package:

```typescript
export interface PluginUIElement {
  id: string;
  type: string;
  location: string;
  [key: string]: unknown;
}

export interface FieldValidation {
  status: 'error' | 'warning' | 'success';
  message: string;
}

export type ConfigLabelColor = 'default' | 'success' | 'error' | 'warning' | 'transient';

export interface PluginContext {
  config: Record<string, unknown>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  registerUI(elements: PluginUIElement[]): void;
  updateConfigLabel(labelId: string, text: string, color?: ConfigLabelColor): void;
}

export interface TicketingBackend {
  id: string;
  name: string;
  capabilities: BackendCapabilities;
  fieldMappings: FieldMappings;
  createRemote(ticket: Ticket): Promise<string>;
  updateRemote(remoteId: string, changes: Partial<RemoteTicketFields>): Promise<void>;
  deleteRemote(remoteId: string): Promise<void>;
  pullChanges(since: Date | null): Promise<RemoteChange[]>;
  getRemoteTicket?(remoteId: string): Promise<RemoteTicketFields | null>;
  checkConnection(): Promise<{ connected: boolean; error?: string }>;
  getRemoteUrl?(remoteId: string): string | null;
  shouldAutoSync?(ticket: Ticket): boolean;
  getComments?(remoteId: string): Promise<RemoteComment[]>;
  createComment?(remoteId: string, text: string): Promise<string>;
  updateComment?(remoteId: string, commentId: string, text: string): Promise<void>;
  deleteComment?(remoteId: string, commentId: string): Promise<void>;
  uploadAttachment?(filename: string, content: Buffer, mimeType: string): Promise<string | null>;
}

export interface BackendCapabilities {
  create: boolean;
  update: boolean;
  delete: boolean;
  incrementalPull: boolean;
  syncableFields: (keyof RemoteTicketFields)[];
  comments?: boolean;
}

export interface FieldMappings {
  category: FieldMap;
  priority: FieldMap;
  status: FieldMap;
}

export interface FieldMap<T extends string = string> {
  toRemote: Record<string, string>;
  toLocal: Record<string, T>;
}

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
  remoteId: string;
  fields: Partial<RemoteTicketFields>;
  remoteUpdatedAt: Date;
  deleted?: boolean;
}

export interface RemoteComment {
  id: string;
  text: string;
  createdAt: Date;
  updatedAt: Date;
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
  tags: string;
  [key: string]: unknown;
}
```

## Installation

Place the plugin directory in `~/.hotsheet/plugins/` and restart Hot Sheet. The plugin will be automatically discovered and loaded.

For development, you can symlink your plugin directory:
```bash
ln -s /path/to/my-plugin ~/.hotsheet/plugins/my-plugin
```

## Reference Implementation

See the GitHub Issues plugin for a complete working example:
- Source: `plugins/github-issues/src/index.ts`
- Manifest: `plugins/github-issues/manifest.json`
- Types: `plugins/github-issues/src/types.ts`

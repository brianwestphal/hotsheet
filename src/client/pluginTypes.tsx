/** Shared types for plugin settings UI modules. */

import type { SafeHtml } from '../jsx-runtime.js';

// HS-8637 — the plugin data shapes now live in the typed API layer
// (`src/api/plugins.ts`) as the wire SSOT. Re-exported here so existing
// consumers keep importing from `./pluginTypes.js`.
export type {
  ConfigLabelColor, ConfigLayoutItem, PluginInfo, PluginPreference, SyncConflict,
} from '../api/plugins.js';

export const STATUS_DOT: Record<'connected' | 'disconnected' | 'error' | 'needsConfig', SafeHtml> = {
  connected: <span className="plugin-status-dot connected" title="Connected"></span>,
  disconnected: <span className="plugin-status-dot disconnected" title="Disconnected"></span>,
  error: <span className="plugin-status-dot error" title="Error"></span>,
  needsConfig: <span className="plugin-status-dot needs-config" title="Needs Configuration"></span>,
};

export function labelColorClass(color: string | undefined): string {
  if (color == null || color === '' || color === 'default') return 'config-label';
  return `config-label label-color-${color}`;
}

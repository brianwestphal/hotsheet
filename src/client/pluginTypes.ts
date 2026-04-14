/** Shared types for plugin settings UI modules. */

export type ConfigLabelColor = 'default' | 'success' | 'error' | 'warning' | 'transient';

export interface ConfigLayoutItem {
  type: 'preference' | 'divider' | 'spacer' | 'label' | 'button' | 'group';
  key?: string;
  id?: string;
  text?: string;
  color?: ConfigLabelColor;
  label?: string;
  action?: string;
  icon?: string;
  style?: string;
  title?: string;
  collapsed?: boolean;
  items?: ConfigLayoutItem[];
}

export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string | null;
  author: string | null;
  enabled: boolean;
  hasBackend: boolean;
  error: string | null;
  preferences: PluginPreference[];
  configLayout?: ConfigLayoutItem[];
  path?: string;
  needsConfiguration?: boolean;
  missingFields?: string[];
}

export interface PluginPreference {
  key: string;
  label: string;
  type: 'string' | 'boolean' | 'number' | 'select' | 'dropdown' | 'combo';
  default?: string | boolean | number;
  description?: string;
  required?: boolean;
  secret?: boolean;
  scope?: 'global' | 'project';
  options?: { value: string; label: string }[];
}

export interface SyncConflict {
  id: number;
  ticket_id: number;
  plugin_id: string;
  remote_id: string;
  sync_status: string;
  conflict_data: string | null;
}

export const STATUS_DOT = {
  connected: '<span class="plugin-status-dot connected" title="Connected"></span>',
  disconnected: '<span class="plugin-status-dot disconnected" title="Disconnected"></span>',
  error: '<span class="plugin-status-dot error" title="Error"></span>',
  needsConfig: '<span class="plugin-status-dot needs-config" title="Needs Configuration"></span>',
};

export function labelColorClass(color: string | undefined): string {
  if (color == null || color === '' || color === 'default') return 'config-label';
  return `config-label label-color-${color}`;
}

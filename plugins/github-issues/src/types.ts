// Minimal type definitions for Hot Sheet plugins.
// These mirror the interfaces from src/plugins/types.ts so the plugin
// can be built independently without importing from the main package.

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

export interface PluginContext {
  config: Record<string, unknown>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  registerUI(elements: PluginUIElement[]): void;
  updateConfigLabel(labelId: string, text: string): void;
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
}

export interface BackendCapabilities {
  create: boolean;
  update: boolean;
  delete: boolean;
  incrementalPull: boolean;
  syncableFields: (keyof RemoteTicketFields)[];
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

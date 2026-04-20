/**
 * Tests for the Demo Plugin — covers activate, onAction, and validateField.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { activate, onAction, validateField } from './index.js';

interface PluginContext {
  config: Record<string, unknown>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  registerUI(elements: unknown[]): void;
  updateConfigLabel(labelId: string, text: string, color?: string): void;
}

function makeContext(settings: Record<string, string> = {}): {
  context: PluginContext;
  logs: { level: string; message: string }[];
  uiElements: unknown[];
  labels: { id: string; text: string; color?: string }[];
} {
  const logs: { level: string; message: string }[] = [];
  const uiElements: unknown[] = [];
  const labels: { id: string; text: string; color?: string }[] = [];
  const context: PluginContext = {
    config: {},
    log: (level, message) => logs.push({ level, message }),
    getSetting: async (key) => settings[key] ?? null,
    setSetting: async () => { /* no-op */ },
    registerUI: (elements) => uiElements.push(...elements),
    updateConfigLabel: (id, text, color) => labels.push({ id, text, color }),
  };
  return { context, logs, uiElements, labels };
}

// --- activate ---

describe('activate', () => {
  it('registers 9 UI elements (8 buttons + 1 link)', async () => {
    const { context, uiElements } = makeContext();
    await activate(context);
    expect(uiElements.length).toBe(9);
  });

  it('registers buttons at all 8 locations', async () => {
    const { context, uiElements } = makeContext();
    await activate(context);
    const locations = (uiElements as { location: string }[]).map(el => el.location);
    expect(locations).toContain('toolbar');
    expect(locations).toContain('status_bar');
    expect(locations).toContain('detail_top');
    expect(locations).toContain('detail_bottom');
    expect(locations).toContain('context_menu');
    expect(locations).toContain('batch_menu');
    expect(locations).toContain('sidebar_actions_top');
    expect(locations).toContain('sidebar_actions_bottom');
  });

  it('registers a link element at detail_bottom', async () => {
    const { context, uiElements } = makeContext();
    await activate(context);
    const link = (uiElements as { type: string; location: string; url?: string }[])
      .find(el => el.type === 'link');
    expect(link).toBeDefined();
    expect(link!.location).toBe('detail_bottom');
    expect(link!.url).toBe('https://github.com');
  });

  it('logs activation without username', async () => {
    const { context, logs } = makeContext();
    await activate(context);
    expect(logs).toContainEqual({ level: 'info', message: 'Demo plugin activated' });
  });

  it('logs activation with username', async () => {
    const { context, logs } = makeContext({ username: 'alice' });
    await activate(context);
    expect(logs).toContainEqual({ level: 'info', message: 'Demo plugin activated for alice' });
  });

  it('includes username in status bar label when set', async () => {
    const { context, uiElements } = makeContext({ username: 'bob' });
    await activate(context);
    const statusBtn = (uiElements as { location: string; label?: string }[])
      .find(el => el.location === 'status_bar');
    expect(statusBtn!.label).toBe('Demo: bob');
  });

  it('uses default label when no username', async () => {
    const { context, uiElements } = makeContext();
    await activate(context);
    const statusBtn = (uiElements as { location: string; label?: string }[])
      .find(el => el.location === 'status_bar');
    expect(statusBtn!.label).toBe('Demo Plugin');
  });

  it('each button has a unique id and action', async () => {
    const { context, uiElements } = makeContext();
    await activate(context);
    const buttons = (uiElements as { type: string; id: string; action?: string }[])
      .filter(el => el.type === 'button');
    const ids = buttons.map(b => b.id);
    const actions = buttons.map(b => b.action);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(actions).size).toBe(actions.length);
  });
});

// --- onAction ---

describe('onAction', () => {
  beforeEach(async () => {
    const { context } = makeContext({ api_key: 'test-key-12345', username: 'alice' });
    await activate(context);
  });

  it('test_connection: returns connected when credentials are valid', async () => {
    const result = await onAction('test_connection', {});
    expect(result).toEqual({ connected: true });
  });

  it('test_connection: returns error when api_key is missing', async () => {
    const { context } = makeContext({ username: 'alice' });
    await activate(context);
    const result = await onAction('test_connection', {});
    expect(result).toEqual({ connected: false, error: 'Missing api_key or username' });
  });

  it('test_connection: returns error when username is missing', async () => {
    const { context } = makeContext({ api_key: 'longkey123' });
    await activate(context);
    const result = await onAction('test_connection', {});
    expect(result).toEqual({ connected: false, error: 'Missing api_key or username' });
  });

  it('test_connection: returns error when api_key is too short', async () => {
    const { context, labels } = makeContext({ api_key: 'short', username: 'alice' });
    await activate(context);
    const result = await onAction('test_connection', {});
    expect(result).toEqual({ connected: false, error: 'API key too short' });
    expect(labels).toContainEqual({ id: 'connection-status', text: 'Invalid API key (too short)', color: 'error' });
  });

  it('test_connection: updates label to connected on success', async () => {
    const { context, labels } = makeContext({ api_key: 'valid-key-123', username: 'bob' });
    await activate(context);
    await onAction('test_connection', {});
    expect(labels).toContainEqual({ id: 'connection-status', text: 'Connected as bob', color: 'success' });
  });

  it('test_connection: updates label to warning when fields missing', async () => {
    const { context, labels } = makeContext({});
    await activate(context);
    await onAction('test_connection', {});
    expect(labels).toContainEqual({ id: 'connection-status', text: 'Missing required fields', color: 'warning' });
  });

  it('toolbar_click: returns message and logs', async () => {
    const result = await onAction('toolbar_click', {});
    expect(result).toEqual({ message: 'Toolbar action executed' });
  });

  it('status_click: returns message and logs', async () => {
    const result = await onAction('status_click', {});
    expect(result).toEqual({ message: 'Status bar action executed' });
  });

  it('detail_top_click: returns ticket count', async () => {
    const result = await onAction('detail_top_click', { ticketIds: [1, 2, 3] });
    expect(result).toEqual({ message: 'Info for 3 ticket(s)' });
  });

  it('detail_top_click: handles missing ticketIds', async () => {
    const result = await onAction('detail_top_click', {});
    expect(result).toEqual({ message: 'Info for 0 ticket(s)' });
  });

  it('detail_bottom_click: returns ticket count', async () => {
    const result = await onAction('detail_bottom_click', { ticketIds: [5] });
    expect(result).toEqual({ message: 'Notified for 1 ticket(s)' });
  });

  it('context_click: returns ticket count', async () => {
    const result = await onAction('context_click', { ticketIds: [10, 20] });
    expect(result).toEqual({ message: 'Context action on 2 ticket(s)' });
  });

  it('sidebar_top_click: returns message', async () => {
    const result = await onAction('sidebar_top_click', {});
    expect(result).toEqual({ message: 'Sidebar top action executed' });
  });

  it('sidebar_bottom_click: returns message', async () => {
    const result = await onAction('sidebar_bottom_click', {});
    expect(result).toEqual({ message: 'Sidebar bottom action executed' });
  });

  it('batch_click: returns ticket count', async () => {
    const result = await onAction('batch_click', { ticketIds: [1, 2, 3, 4] });
    expect(result).toEqual({ message: 'Batch action on 4 ticket(s)' });
  });

  it('unknown action: returns null', async () => {
    const result = await onAction('nonexistent_action', {});
    expect(result).toBeNull();
  });
});

// --- validateField ---

describe('validateField', () => {
  describe('api_key', () => {
    it('returns error when empty', async () => {
      expect(await validateField('api_key', '')).toEqual({ status: 'error', message: 'Required' });
    });

    it('returns warning when too short', async () => {
      expect(await validateField('api_key', 'short')).toEqual({ status: 'warning', message: 'Key should be at least 8 characters' });
    });

    it('returns success when valid', async () => {
      expect(await validateField('api_key', 'longkey123')).toEqual({ status: 'success', message: 'Valid API key format' });
    });
  });

  describe('username', () => {
    it('returns error when empty', async () => {
      expect(await validateField('username', '')).toEqual({ status: 'error', message: 'Required' });
    });

    it('returns error when contains spaces', async () => {
      expect(await validateField('username', 'has space')).toEqual({ status: 'error', message: 'Cannot contain spaces' });
    });

    it('returns warning when very short', async () => {
      expect(await validateField('username', 'ab')).toEqual({ status: 'warning', message: 'Username is very short' });
    });

    it('returns success with greeting', async () => {
      expect(await validateField('username', 'alice')).toEqual({ status: 'success', message: 'Hello, alice!' });
    });
  });

  describe('webhook_url', () => {
    it('returns null when empty (optional field)', async () => {
      expect(await validateField('webhook_url', '')).toBeNull();
    });

    it('returns warning for non-HTTPS URL', async () => {
      expect(await validateField('webhook_url', 'http://example.com/hook')).toEqual({ status: 'warning', message: 'HTTPS recommended' });
    });

    it('returns success for HTTPS URL', async () => {
      expect(await validateField('webhook_url', 'https://example.com/hook')).toEqual({ status: 'success', message: 'Valid URL' });
    });

    it('returns error for invalid URL', async () => {
      expect(await validateField('webhook_url', 'not-a-url')).toEqual({ status: 'error', message: 'Invalid URL format' });
    });
  });

  describe('max_items', () => {
    it('returns error for non-number', async () => {
      expect(await validateField('max_items', 'abc')).toEqual({ status: 'error', message: 'Must be a number' });
    });

    it('returns error for zero', async () => {
      expect(await validateField('max_items', '0')).toEqual({ status: 'error', message: 'Must be at least 1' });
    });

    it('returns error for negative', async () => {
      expect(await validateField('max_items', '-5')).toEqual({ status: 'error', message: 'Must be at least 1' });
    });

    it('returns warning for large value', async () => {
      expect(await validateField('max_items', '5000')).toEqual({ status: 'warning', message: 'Large values may be slow' });
    });

    it('returns null for valid value', async () => {
      expect(await validateField('max_items', '50')).toBeNull();
    });
  });

  describe('unknown key', () => {
    it('returns null', async () => {
      expect(await validateField('unknown_field', 'anything')).toBeNull();
    });
  });
});

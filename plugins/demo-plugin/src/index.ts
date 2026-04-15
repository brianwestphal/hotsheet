/**
 * Demo Plugin — exercises all Hot Sheet plugin features.
 * For local development and testing only. Not a ticketing backend — just
 * demonstrates settings UI, config layout, label colors, field validation,
 * and all UI extension locations.
 */

interface PluginContext {
  config: Record<string, unknown>;
  log(level: 'info' | 'warn' | 'error', message: string): void;
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
  registerUI(elements: PluginUIElement[]): void;
  updateConfigLabel(labelId: string, text: string, color?: 'default' | 'success' | 'error' | 'warning' | 'transient'): void;
}

interface PluginUIElement {
  id: string;
  type: string;
  location: string;
  [key: string]: unknown;
}

let context: PluginContext;

const BOLT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>';
const INFO_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';
const BELL_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>';

export async function activate(ctx: PluginContext): Promise<void> {
  context = ctx;
  const username = await ctx.getSetting('username');

  ctx.registerUI([
    // --- Buttons (all locations + styles) ---

    // Toolbar: default style
    {
      id: 'demo-toolbar',
      type: 'button',
      location: 'toolbar',
      icon: BOLT_ICON,
      title: 'Demo Plugin Action',
      action: 'toolbar_click',
    } as PluginUIElement,

    // Status bar
    {
      id: 'demo-status',
      type: 'button',
      location: 'status_bar',
      label: username ? `Demo: ${username}` : 'Demo Plugin',
      title: 'Demo status bar button',
      action: 'status_click',
    } as PluginUIElement,

    // Detail panel — top (above fields)
    {
      id: 'demo-detail-top',
      type: 'button',
      location: 'detail_top',
      icon: INFO_ICON,
      label: 'Ticket Info',
      title: 'Demo detail top button',
      action: 'detail_top_click',
    } as PluginUIElement,

    // Detail panel — bottom (below notes), primary style
    {
      id: 'demo-detail-bottom',
      type: 'button',
      location: 'detail_bottom',
      icon: BELL_ICON,
      label: 'Notify',
      title: 'Demo detail bottom button (primary style)',
      style: 'primary',
      action: 'detail_bottom_click',
    } as PluginUIElement,

    // Context menu
    {
      id: 'demo-context',
      type: 'button',
      location: 'context_menu',
      icon: BOLT_ICON,
      label: 'Demo Action',
      title: 'Demo context menu item',
      action: 'context_click',
    } as PluginUIElement,

    // Batch menu (shown when multiple tickets selected → "..." menu)
    {
      id: 'demo-batch',
      type: 'button',
      location: 'batch_menu',
      icon: BOLT_ICON,
      label: 'Demo Batch Action',
      title: 'Demo batch menu item',
      action: 'batch_click',
    } as PluginUIElement,

    // --- Sidebar ---

    // Sidebar top (before views)
    {
      id: 'demo-sidebar-top',
      type: 'button',
      location: 'sidebar_actions_top',
      icon: BOLT_ICON,
      label: 'Demo Sidebar',
      title: 'Demo sidebar top button',
      action: 'sidebar_top_click',
    } as PluginUIElement,

    // Sidebar bottom (after views)
    {
      id: 'demo-sidebar-bottom',
      type: 'button',
      location: 'sidebar_actions_bottom',
      icon: INFO_ICON,
      label: 'Demo Bottom',
      title: 'Demo sidebar bottom button',
      action: 'sidebar_bottom_click',
    } as PluginUIElement,

    // --- Link ---

    {
      id: 'demo-link',
      type: 'link',
      location: 'detail_bottom',
      url: 'https://github.com',
      label: 'GitHub',
      icon: INFO_ICON,
      title: 'Demo external link',
    } as PluginUIElement,
  ]);

  ctx.log('info', `Demo plugin activated${username ? ` for ${username}` : ''}`);
}

export async function onAction(actionId: string, _actionContext: { ticketIds?: number[]; value?: unknown }): Promise<unknown> {
  if (actionId === 'test_connection') {
    const apiKey = await context.getSetting('api_key');
    const username = await context.getSetting('username');

    if (!apiKey || !username) {
      context.updateConfigLabel('connection-status', 'Missing required fields', 'warning');
      return { connected: false, error: 'Missing api_key or username' };
    }

    // Simulate a connection check with a brief delay
    await new Promise(r => setTimeout(r, 500));

    if (apiKey.length < 8) {
      context.updateConfigLabel('connection-status', 'Invalid API key (too short)', 'error');
      return { connected: false, error: 'API key too short' };
    }

    context.updateConfigLabel('connection-status', `Connected as ${username}`, 'success');
    return { connected: true };
  }

  if (actionId === 'toolbar_click') {
    context.log('info', 'Toolbar button clicked');
    return { message: 'Toolbar action executed' };
  }

  if (actionId === 'status_click') {
    context.log('info', 'Status bar button clicked');
    return { message: 'Status bar action executed' };
  }

  if (actionId === 'detail_top_click') {
    const ticketIds = _actionContext.ticketIds ?? [];
    context.log('info', `Detail top button clicked for tickets: ${ticketIds.join(', ')}`);
    return { message: `Info for ${ticketIds.length} ticket(s)` };
  }

  if (actionId === 'detail_bottom_click') {
    const ticketIds = _actionContext.ticketIds ?? [];
    context.log('info', `Detail bottom (notify) clicked for tickets: ${ticketIds.join(', ')}`);
    return { message: `Notified for ${ticketIds.length} ticket(s)` };
  }

  if (actionId === 'context_click') {
    const ticketIds = _actionContext.ticketIds ?? [];
    context.log('info', `Context menu action for tickets: ${ticketIds.join(', ')}`);
    return { message: `Context action on ${ticketIds.length} ticket(s)` };
  }

  if (actionId === 'sidebar_top_click') {
    context.log('info', 'Sidebar top button clicked');
    return { message: 'Sidebar action executed' };
  }

  if (actionId === 'batch_click') {
    const ticketIds = _actionContext.ticketIds ?? [];
    context.log('info', `Batch action for tickets: ${ticketIds.join(', ')}`);
    return { message: `Batch action on ${ticketIds.length} ticket(s)` };
  }

  return null;
}

export async function validateField(key: string, value: string): Promise<{ status: string; message: string } | null> {
  if (key === 'api_key') {
    if (!value) return { status: 'error', message: 'Required' };
    if (value.length < 8) return { status: 'warning', message: 'Key should be at least 8 characters' };
    return { status: 'success', message: 'Valid API key format' };
  }

  if (key === 'username') {
    if (!value) return { status: 'error', message: 'Required' };
    if (/\s/.test(value)) return { status: 'error', message: 'Cannot contain spaces' };
    if (value.length < 3) return { status: 'warning', message: 'Username is very short' };
    return { status: 'success', message: `Hello, ${value}!` };
  }

  if (key === 'webhook_url') {
    if (!value) return null; // Optional — no feedback when empty
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:') return { status: 'warning', message: 'HTTPS recommended' };
      return { status: 'success', message: 'Valid URL' };
    } catch {
      return { status: 'error', message: 'Invalid URL format' };
    }
  }

  if (key === 'max_items') {
    const n = parseInt(value, 10);
    if (isNaN(n)) return { status: 'error', message: 'Must be a number' };
    if (n < 1) return { status: 'error', message: 'Must be at least 1' };
    if (n > 1000) return { status: 'warning', message: 'Large values may be slow' };
    return null;
  }

  return null;
}

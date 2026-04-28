/**
 * HS-7977 — drawer-tab gating for the Tauri/browser split.
 *
 * Terminals (xterm + PTY WebSocket) are a Tauri-only feature. When Hot Sheet
 * is accessed via a plain browser (no `window.__TAURI__`), saved drawer state
 * may still hold a `terminal:<id>` `drawer_active_tab` from the user's last
 * desktop session. Activating that tab in a browser would render an empty
 * pane and (pre-fix) trigger `loadAndRenderTerminalTabs()` which spun up
 * xterm instances + opened WebSockets that nobody can see.
 *
 * Pure helper so the logic can be unit-tested without mounting commandLog.tsx
 * (which pulls in the full client bundle).
 */
export function resolveDrawerTabForTauri(requestedTab: string, isTauri: boolean): string {
  if (!isTauri && requestedTab.startsWith('terminal:')) return 'commands-log';
  return requestedTab;
}

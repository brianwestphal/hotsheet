import { getActiveProject } from './state.js';
import { getTauriInvoke } from './tauriIntegration.js';

/** HS-8451 — single entry point for "set the visible app title."
 *  Updates three surfaces in lockstep:
 *    1. `document.title` (browser tab + the source of truth `requestAttention`
 *       uses for its flash-the-title fallback).
 *    2. The in-app `.app-title h1` heading element rendered in the sidebar.
 *    3. The native window title via Tauri's `set_window_title` command.
 *       Tauri does NOT auto-sync `document.title` to the native chrome, so
 *       the WKWebView's window title bar stays frozen at whatever Tauri's
 *       Rust side set during startup unless we explicitly invoke this
 *       command. Failure-open: a probe error or a missing Tauri runtime
 *       just leaves the native title unchanged.
 */
export function setAppTitle(title: string): void {
  document.title = title;
  const h1 = document.querySelector('.app-title h1');
  if (h1 !== null) h1.textContent = title;
  const invoke = getTauriInvoke();
  if (invoke !== null) {
    void invoke('set_window_title', { title }).catch(() => { /* failure-open */ });
  }
}

/** HS-8451 — derive the title from the active project's `name` field (which
 *  `src/projects.ts::registerProject` populates with `appName` from the project's
 *  `settings.json` or a folder-name fallback, so the value is already correct
 *  without a separate `/file-settings` round-trip). Falls back to "Hot Sheet"
 *  when no project is active (boot-time edge cases). */
export function setAppTitleFromActiveProject(): void {
  const project = getActiveProject();
  setAppTitle(project?.name ?? 'Hot Sheet');
}

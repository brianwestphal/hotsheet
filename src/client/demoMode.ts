/**
 * HS-8688 — shared client-side "is this app running under `--demo:N`?" check.
 *
 * The server stamps `window.__HOTSHEET_DEMO__ = true` in the page `<head>`
 * synchronously (`src/components/layout.tsx`, gated on the process-global
 * `isDemoMode()` from `src/demo-mode.ts`, set in `src/cli.ts` when launched
 * with `--demo:N`). The stamp is available BEFORE `app.js` runs so the very
 * first module that reads it gets the right answer — same shape as the e2e
 * `window.__HOTSHEET_DISABLE_WEBGL__` force-disable seam.
 *
 * **Use this gate to suppress demo-distracting UI** that would otherwise leak
 * into screenshot captures: post-boot toast banners, "service not connected"
 * warnings, update nudges, telemetry consent prompts, etc. The terminal-
 * renderer gate in `terminalWebgl.ts` had its own private copy of this check
 * (HS-8612); HS-8688 added two more consumers (`clipboardUtil.tsx` for the
 * skills banner + `channelUI.tsx` for the Claude-not-connected warning) and
 * extracting the helper keeps every gate in lockstep.
 */
export function isDemoMode(): boolean {
  if (typeof window === 'undefined') return false;
  return (window as unknown as { __HOTSHEET_DEMO__?: boolean }).__HOTSHEET_DEMO__ === true;
}

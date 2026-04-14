/** Build-time feature flags.
 *  In production builds, __PLUGINS_ENABLED__ is replaced at build time by tsup/esbuild `define`.
 *  In dev mode (tsx), falls back to process.env.PLUGINS_ENABLED.
 *  In browser contexts, neither process nor __PLUGINS_ENABLED__ exist — defaults to true. */

declare const __PLUGINS_ENABLED__: boolean;

function resolvePluginsEnabled(): boolean {
  // Build-time define (production builds)
  if (typeof __PLUGINS_ENABLED__ !== 'undefined') return __PLUGINS_ENABLED__;
  // Runtime env var (tsx dev mode, Node.js) — opt-out with PLUGINS_ENABLED=false
  if (typeof process !== 'undefined') return process.env.PLUGINS_ENABLED !== 'false';
  // Browser without build-time define
  return true;
}

export const PLUGINS_ENABLED: boolean = resolvePluginsEnabled();

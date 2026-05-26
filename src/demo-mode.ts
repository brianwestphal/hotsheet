/**
 * HS-8612 — process-global "are we running under `--demo:N`?" flag.
 *
 * Demo mode is a launch-time concept (`src/cli.ts` resolves a temp dataDir and
 * seeds sample data via `src/demo.ts`), but it has no per-request shape — once
 * the process is launched with `--demo`, every page served is a demo page. So a
 * single module-level boolean, set once at startup before the server begins
 * serving, is the right model.
 *
 * The one client consumer is the terminal renderer: demo mode must force the
 * DOM renderer (never WebGL) so domotion-svg can DOM-capture the live
 * `<span>`-per-cell tree (a `<canvas>` can't be captured that way — see
 * §22.21). The page shell (`src/components/layout.tsx`) reads this at render
 * time and stamps `window.__HOTSHEET_DEMO__` so the decision is available
 * synchronously, before `app.js` runs — mirroring the e2e force-disable seam
 * (`__HOTSHEET_DISABLE_WEBGL__`), which `shouldUseWebglRenderer()` reads the
 * same way.
 *
 * Kept in its own DB-free module (not `src/demo.ts`, which imports the PGLite
 * connection) so the page route can read it without pulling in the seeder.
 */

let demoMode = false;

/** Mark the process as running in demo mode. Called once from `src/cli.ts`
 *  when launched with `--demo:N`, before the server starts serving. */
export function setDemoMode(value: boolean): void {
  demoMode = value;
}

/** Whether the process was launched in demo mode. Read by the page shell to
 *  stamp `window.__HOTSHEET_DEMO__`. */
export function isDemoMode(): boolean {
  return demoMode;
}

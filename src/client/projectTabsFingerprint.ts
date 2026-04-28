/**
 * HS-7972 — pure fingerprint helper for the project-tab strip.
 *
 * `renderTabs()` previously tore down + rebuilt the entire tab strip on every
 * `/api/poll` version bump. When the version was bumping rapidly (e.g. macOS
 * fs.watch firing burst events on `.git/index`), the user saw the project-tab
 * `:hover` outline flicker — the DOM was being replaced under the cursor, so
 * the browser kept losing + re-applying the hover state.
 *
 * This helper turns the strip-defining inputs (project order, names, active
 * secret) into a short stable string. `renderTabs()` short-circuits on an
 * unchanged fingerprint and skips the DOM rebuild entirely. Status dots +
 * bell glyphs are toggled in-place by `updateStatusDots` /
 * `updateProjectBellIndicators` and intentionally aren't part of the
 * fingerprint.
 *
 * Exported as its own file so the helper is unit-testable without pulling
 * the full client bundle (state.tsx → terminalIntegration → xterm imports …).
 */
export function computeProjectTabsFingerprint(
  projects: ReadonlyArray<{ secret: string; name: string }>,
  activeSecret: string | null,
): string {
  if (projects.length < 2) {
    return `single|${projects.length === 1 ? projects[0].name : 'Hot Sheet'}`;
  }
  return projects.map(p => `${p.secret}|${p.name}|${p.secret === activeSecret ? '1' : '0'}`).join('||');
}

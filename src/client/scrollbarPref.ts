/**
 * HS-8494 — detect the user's scrollbar preference at app boot so the
 * two horizontal-tab strips that explicitly suppress scrollbars
 * (`.project-tabs-inner` + `.settings-tabs`) can switch on a visible
 * thumb when the OS / browser reserves space for scrollbars.
 *
 * **Detection.** Append an off-screen `<div>` with `overflow: scroll`
 * to the document, measure `offsetWidth - clientWidth`. The difference
 * is the width the browser reserved for the vertical scrollbar:
 *   - macOS "Automatic" (overlay scrollbars) → 0 px reserved
 *   - macOS "Always" (classic scrollbars) → 15-16 px reserved
 *   - Linux / Windows defaults → typically 15-17 px reserved
 *   - Tauri WKWebView on macOS → inherits the macOS preference
 *
 * Hot Sheet adds `body.scrollbars-always-visible` when the diff is
 * non-zero. The two suppression rules in `styles.scss` are gated on
 * the absence of that class.
 *
 * Detection runs once at app boot — no repeat checks. macOS users
 * who flip System Settings → Appearance → Show scroll bars need to
 * reload Hot Sheet for the change to take effect. The trade-off:
 * polling for the preference is wasteful + a `MutationObserver` on
 * the body won't catch OS preference flips. A reload is the standard
 * recovery path; the documentation in HS-8494 captures this.
 */

export function detectScrollbarsAlwaysVisible(): boolean {
  // happy-dom and similar test environments don't always implement
  // overflow-scroll layout consistently. Guard the document write +
  // measurement so a missing `document.body` doesn't blow up app
  // boot under tests.
  // `document.body` is typed as `HTMLElement` (never null in modern
  // DOMs) but happy-dom test environments don't always populate it
  // before script execution. Guard the cast defensively.
  const body = document.body as HTMLElement | null;
  if (body === null) return false;
  const probe = document.createElement('div');
  probe.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden;pointer-events:none;';
  body.appendChild(probe);
  const diff = probe.offsetWidth - probe.clientWidth;
  probe.remove();
  return diff > 0;
}

export function applyScrollbarPrefClass(): void {
  if (detectScrollbarsAlwaysVisible()) {
    document.body.classList.add('scrollbars-always-visible');
  }
}

/**
 * **HS-8494 follow-up** — watch `element` for horizontal-overflow state
 * changes and mirror the result into a `has-overflow` class. The CSS
 * rules in `styles.scss` flip the strip from `overflow-x: auto` to
 * `overflow-x: scroll` when the class is present, which forces webkit
 * to always render the iOS thumb on rapid resize. With `auto` alone
 * webkit occasionally fails to repaint the scrollbar after the strip
 * transitions from "fits" → "overflows" mid-resize.
 *
 * Returns a `dispose()` to stop the observer + clear the class.
 */
export function watchHorizontalOverflow(element: HTMLElement): () => void {
  const update = (): void => {
    const overflows = element.scrollWidth > element.clientWidth + 1;
    element.classList.toggle('has-overflow', overflows);
  };
  update();
  const ro = new ResizeObserver(update);
  ro.observe(element);
  // Also re-run after any child mutation (tabs added / removed / renamed)
  // so the class flips even when no resize event fires.
  const mo = new MutationObserver(update);
  mo.observe(element, { childList: true, subtree: true, characterData: true });
  return () => {
    ro.disconnect();
    mo.disconnect();
    element.classList.remove('has-overflow');
  };
}

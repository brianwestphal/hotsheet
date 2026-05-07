/**
 * Tiny event-delegation helpers. Replace per-element `addEventListener` calls
 * (which don't survive morph re-renders for nodes morphdom creates) with one
 * listener at the morph-root that dispatches via `closest()`.
 *
 * See `docs/63-reactivity-demo-plan.md` §63.3 for the three-tier listener
 * model:
 *   - Tier 1 (bubbling events) — use `delegate()`.
 *   - Tier 2 (non-bubbling events: focus / blur / scroll / load / error) —
 *     use `delegateCapture()`.
 *   - Tier 3 (per-element instances / library-owned subtrees) — mark the
 *     host element with `data-morph-skip` and manage the library's
 *     lifecycle directly (e.g. how `terminalCheckout.tsx` manages xterm).
 */

type Handler = (event: Event, target: Element) => void;

/**
 * Bubble-phase delegation. Installs ONE listener on `rootEl` for the given
 * event type. When the event fires, walks up from `event.target` to the root
 * looking for an element matching `selector`; if found, fires `handler` with
 * the matched element as the second arg.
 *
 * Returns a disposer that removes the listener.
 *
 * Usage (pseudo-code — see demo sections for live examples):
 *   delegate(rootEl, 'click', '[data-action="add"]', handlerFn);
 */
export function delegate(
  rootEl: HTMLElement,
  type: string,
  selector: string,
  handler: Handler,
): () => void {
  const listener = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const matched = target.closest(selector);
    if (matched !== null && rootEl.contains(matched)) {
      handler(event, matched);
    }
  };
  rootEl.addEventListener(type, listener);
  return () => {
    rootEl.removeEventListener(type, listener);
  };
}

/**
 * Capture-phase delegation — for non-bubbling events (`focus`, `blur`,
 * `scroll`, `load`, `error`). The capture phase fires on the way DOWN from
 * the root to the target, so a root-level listener with `capture: true` sees
 * events that wouldn't bubble back up.
 *
 * Usage (pseudo-code — see demo sections for live examples):
 *   delegateCapture(rootEl, 'focus', 'input, textarea', handlerFn);
 */
export function delegateCapture(
  rootEl: HTMLElement,
  type: string,
  selector: string,
  handler: Handler,
): () => void {
  const listener = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.matches(selector) && rootEl.contains(target)) {
      handler(event, target);
    }
  };
  rootEl.addEventListener(type, listener, true);
  return () => {
    rootEl.removeEventListener(type, listener, true);
  };
}

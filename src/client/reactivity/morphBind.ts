/**
 * `morphBind(rootEl, render)` — the single render-path primitive.
 *
 * Wraps `effect()` from `reactive.ts` so that whenever any signal read inside
 * `render()` changes, we re-run `render()` and use `morphdom` to apply the
 * minimal set of DOM mutations against the live tree. Preserves element
 * identity (and thus focus, selection, in-flight pointer interactions, and
 * event listeners on preserved nodes) wherever the keyed/positional diff
 * matches.
 *
 * Compared to today's `replaceChildren(...rows.map(toElement))` rebuild
 * pattern, the user-visible win is that an `<input>` the user is typing into
 * survives an unrelated re-render — its DOM node, focus state, and cursor
 * position are not destroyed and recreated on each tick.
 *
 * See `docs/63-reactivity-demo-plan.md` §63.2 for the rationale and §63.3 for
 * the listener-tier pattern that complements this primitive.
 */

import morphdom from 'morphdom';

import { SafeHtml } from '../../jsx-runtime.js';
import { effect } from './reactive.js';

/**
 * Bind `render()` to the children of `rootEl`. Re-runs whenever any signal
 * read inside `render()` changes. Returns a disposer that tears down the
 * effect; call it when the host element is removed from the DOM.
 *
 * Conventions:
 *
 * - Diff keys: `id`, `data-key`, plus a small set of Hot Sheet-conventional
 *   keys (`data-ticket-id`, `data-terminal-id`, `data-project-secret`).
 *   Elements with one of these keys are matched across the morph by key
 *   rather than positionally — list reorders move existing nodes instead of
 *   churning unrelated siblings.
 * - `data-morph-skip`: any element with this attribute is left untouched
 *   inside. Used for library-owned subtrees (xterm-style widgets) where the
 *   library's own lifecycle manages the children.
 * - Focused text-entry inputs (`<input>` of typing kinds, `<textarea>`,
 *   `[contenteditable]`) keep their current value + selection range across
 *   morphs while focused. The user never sees their cursor jump mid-keystroke.
 */
export function morphBind(rootEl: HTMLElement, render: () => SafeHtml | string): () => void {
  return effect(() => {
    const next = render();
    const html = next instanceof SafeHtml ? next.toString() : next;

    const template = rootEl.cloneNode(false) as HTMLElement;
    template.innerHTML = html;

    morphdom(rootEl, template, {
      childrenOnly: true,
      getNodeKey: (node) => {
        if (node.nodeType !== 1) return undefined;
        const el = node as HTMLElement;
        if (el.id !== '') return el.id;
        if (el.dataset.key != null) return `key:${el.dataset.key}`;
        if (el.dataset.ticketId != null) return `ticket:${el.dataset.ticketId}`;
        if (el.dataset.terminalId != null) return `term:${el.dataset.terminalId}`;
        if (el.dataset.projectSecret != null) return `proj:${el.dataset.projectSecret}`;
        return undefined;
      },
      onBeforeElUpdated: (fromEl, toEl) => {
        if (fromEl.dataset.morphSkip != null) return false;
        if (fromEl.isEqualNode(toEl)) return false;
        if (fromEl === document.activeElement && isTextEntry(fromEl)) {
          preserveTextEntryState(fromEl, toEl);
        }
        return true;
      },
    });
  });
}

function isTextEntry(el: Element): boolean {
  if (el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return type === 'text' || type === 'search' || type === 'url' || type === 'email'
      || type === 'tel' || type === 'password' || type === '';
  }
  return (el as HTMLElement).isContentEditable;
}

function preserveTextEntryState(fromEl: HTMLElement, toEl: HTMLElement): void {
  if (fromEl.tagName === 'TEXTAREA' || fromEl.tagName === 'INPUT') {
    const fromInput = fromEl as HTMLInputElement;
    const toInput = toEl as HTMLInputElement;
    toInput.value = fromInput.value;
    try {
      toInput.setSelectionRange(fromInput.selectionStart, fromInput.selectionEnd);
    } catch {
      // Some input types (number, range, color, …) reject selection APIs.
    }
  }
}

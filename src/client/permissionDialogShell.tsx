/**
 * HS-8066 — shared dialog-shell for §47's permission popup
 * (`permissionOverlay.tsx`) and §52's terminal-prompt overlay
 * (`terminalPromptOverlay.tsx`).
 *
 * Both surfaces share more than they look at first glance:
 * - Anchor-below-active-project-tab positioning (HS-7266 / HS-8012 was
 *   line-for-line duplicated).
 * - Non-modal mount on `document.body`.
 * - Esc-to-close handling at capture-phase.
 * - A header rhythm: bold tool/source chip + muted title text + close X.
 * - A footer link row: Minimize · No response needed.
 *
 * Consumers describe content (chip, title, body, footer chrome,
 * lifecycle callbacks); the shell owns the chrome (header, anchor
 * positioning, keyboard handler, link row, DOM teardown). Body and
 * action slots stay pluggable as pre-built DOM elements so each
 * surface keeps its unique visual treatment (§47's icon-only Allow/
 * Deny vs §52's numbered choice list vs §52 generic's textarea +
 * submit) without the shell needing to know about them.
 *
 * **What the shell does NOT own** (deliberately):
 * - Bookkeeping (`respondedRequestIds` / `dismissedRequestIds` /
 *   `minimizedRequests` for §47 vs `lastDispatchedPromptSignatures` +
 *   `minimizedTerminalPrompts` for §52). Different lifecycle models.
 * - Allow-rule storage shape (`permission_allow_rules` vs
 *   `terminal_prompt_allow_rules`). Different match keys.
 * - Server-side dismissal (§47's `/channel/permission/respond` vs
 *   §52's `/terminal/prompt-dismiss`). Different endpoints.
 *
 * Those stay in each consumer's onClose / onMinimize / onNoResponseNeeded
 * callbacks — the shell just fires the lifecycle hooks at the right
 * time.
 */

import type { SafeHtml } from '../jsx-runtime.js';
import { raw } from '../jsx-runtime.js';
import { toElement } from './dom.js';

const X_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>';

export interface PermissionDialogShellOptions {
  /** Outer-overlay class. Consumers use this to retain their existing
   *  CSS scoping (`.permission-popup` for §47, `.terminal-prompt-overlay`
   *  for §52). The shell adds its own structural classes underneath
   *  (`.dialog-shell-header`, `.dialog-shell-footer`, etc.). */
  rootClassName: string;
  /** ARIA-label for the role=dialog wrapper. */
  ariaLabel: string;
  /** Bold source label rendered first in the header (e.g. `Bash`,
   *  `Claude`, `Shell`). Optional — when absent, header opens with
   *  the title text instead. */
  toolChip?: string;
  /** Primary title line (e.g. permission description, prompt question).
   *  Mandatory — the header always has at least this. */
  title: string;
  /** Optional second line (currently unused by §47; reserved). */
  description?: string;
  /** Body content. Either pre-rendered HTML (consumer's responsibility
   *  to escape) or a pre-built DOM tree (e.g. mirror xterm from
   *  HS-7999). At most one renders; both `null`/`undefined` means no
   *  body block. */
  bodyHtml?: SafeHtml;
  bodyElement?: HTMLElement;
  /** Action row DOM tree — usually a `<div>` carrying the consumer's
   *  Allow/Deny / numbered-choice / yes-no / textarea+submit markup.
   *  The shell appends it after the body, before any always-allow
   *  affordance. */
  actions?: HTMLElement;
  /** Optional always-do-this affordance — checkbox / editable pattern
   *  / etc. The shell drops this in between the action row and the
   *  footer-link row. */
  alwaysAffordance?: HTMLElement | null;
  /** When provided, renders a `Minimize` link in the footer. The shell
   *  closes the overlay (DOM teardown + Esc handler dispose) BEFORE
   *  firing the callback so dispatcher state can update without
   *  fighting the overlay lifecycle. */
  onMinimize?: () => void;
  /** Same shape as onMinimize, footer label `No response needed`. */
  onNoResponseNeeded?: () => void;
  /** Project secret used to find the corresponding `.project-tab` in
   *  the DOM and anchor the overlay below it. When absent or the tab
   *  isn't visible (e.g. dashboard mode), the SCSS-default position
   *  (top-center) wins. */
  projectSecret?: string;
  /** Lifecycle hook fired after the overlay's DOM is torn down via
   *  the close button OR Esc. NOT fired for Minimize / No response
   *  needed (those have their own callbacks above). */
  onClose?: () => void;
  /** When true, Esc closes the overlay and fires onClose. When false,
   *  Esc is unhandled (consumer wires its own — e.g. §52's per-shape
   *  cancel-payload handlers). Default false to preserve back-compat
   *  with the existing per-overlay Esc handlers. */
  escClosesOverlay?: boolean;
}

export interface PermissionDialogShellHandle {
  /** The outer `.permission-popup` / `.terminal-prompt-overlay` root.
   *  Consumers use this to mount additional event listeners on per-
   *  surface elements they wired into the slots. */
  overlay: HTMLElement;
  /** Tear down DOM + dispose keyboard handler. Does NOT fire onClose.
   *  Use this from per-surface flows that already have their own
   *  lifecycle ack (e.g. send/cancel paths). */
  tearDownDom: () => void;
  /** Convenience: tearDownDom + onClose. Use this from per-surface
   *  flows that map cleanly to the standard close lifecycle (X button,
   *  Esc when escClosesOverlay=true). */
  close: () => void;
}

/**
 * Mount a dialog shell into `document.body` and position it below the
 * active `.project-tab[data-secret=projectSecret]`. Returns a handle
 * with the overlay element and lifecycle helpers.
 */
export function openPermissionDialogShell(opts: PermissionDialogShellOptions): PermissionDialogShellHandle {
  const overlay = toElement(
    <div className={opts.rootClassName} role="dialog" aria-modal="false" aria-label={opts.ariaLabel}>
      <div className="dialog-shell-header">
        {opts.toolChip !== undefined && opts.toolChip !== ''
          ? <span className="dialog-shell-tool">{opts.toolChip}</span>
          : null}
        <span className="dialog-shell-title">{opts.title}</span>
        {opts.description !== undefined && opts.description !== ''
          ? <span className="dialog-shell-desc">{opts.description}</span>
          : null}
        <button className="dialog-shell-close" type="button" title="Close" aria-label="Close">
          {raw(X_ICON)}
        </button>
      </div>
      <div className="dialog-shell-body" data-role="body"></div>
      <div className="dialog-shell-actions" data-role="actions"></div>
      <div className="dialog-shell-affordance" data-role="affordance"></div>
      {(opts.onMinimize !== undefined || opts.onNoResponseNeeded !== undefined)
        ? <div className="dialog-shell-links">
            {opts.onMinimize !== undefined
              ? <a className="dialog-shell-minimize-link" href="#">Minimize</a>
              : null}
            {opts.onMinimize !== undefined && opts.onNoResponseNeeded !== undefined
              ? <span className="dialog-shell-links-sep">·</span>
              : null}
            {opts.onNoResponseNeeded !== undefined
              ? <a className="dialog-shell-dismiss-link" href="#">No response needed</a>
              : null}
          </div>
        : null}
    </div>
  );

  // Mount body slot — either bodyElement (DOM tree) or bodyHtml
  // (pre-rendered string). When neither, leave the body slot empty
  // and CSS hides it via `:empty`.
  const bodySlot = overlay.querySelector<HTMLElement>('[data-role="body"]');
  if (bodySlot !== null) {
    if (opts.bodyElement !== undefined) {
      bodySlot.replaceChildren(opts.bodyElement);
    } else if (opts.bodyHtml !== undefined) {
      bodySlot.innerHTML = opts.bodyHtml.toString();
    }
  }

  // Mount actions slot.
  const actionsSlot = overlay.querySelector<HTMLElement>('[data-role="actions"]');
  if (actionsSlot !== null && opts.actions !== undefined) {
    actionsSlot.replaceChildren(opts.actions);
  }

  // Mount always-affordance slot.
  const affordanceSlot = overlay.querySelector<HTMLElement>('[data-role="affordance"]');
  if (affordanceSlot !== null && opts.alwaysAffordance !== undefined && opts.alwaysAffordance !== null) {
    affordanceSlot.replaceChildren(opts.alwaysAffordance);
  }

  let disposed = false;
  function tearDownDom(): void {
    if (disposed) return;
    disposed = true;
    overlay.remove();
    if (escListener !== null) document.removeEventListener('keydown', escListener, true);
  }
  function close(): void {
    if (disposed) return;
    tearDownDom();
    opts.onClose?.();
  }

  // Esc handler — capture phase so it beats the global blur-input
  // shortcut handler in `shortcuts.tsx`.
  let escListener: ((e: KeyboardEvent) => void) | null = null;
  if (opts.escClosesOverlay === true) {
    escListener = (e) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    document.addEventListener('keydown', escListener, true);
  }

  // Wire close button + footer links.
  overlay.querySelector<HTMLButtonElement>('.dialog-shell-close')?.addEventListener('click', (e) => {
    e.stopPropagation();
    close();
  });
  overlay.querySelector<HTMLAnchorElement>('.dialog-shell-minimize-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    tearDownDom();
    opts.onMinimize?.();
  });
  overlay.querySelector<HTMLAnchorElement>('.dialog-shell-dismiss-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    tearDownDom();
    opts.onNoResponseNeeded?.();
  });

  // Mount + position. Append BEFORE positioning so getBoundingClientRect
  // reflects the final layout.
  document.body.appendChild(overlay);
  if (opts.projectSecret !== undefined) {
    positionBelowProjectTab(overlay, opts.projectSecret);
  }

  return { overlay, tearDownDom, close };
}

/**
 * Anchor `overlay` below the active project tab matching `projectSecret`.
 * No-op when the tab isn't in the DOM (e.g. dashboard mode hides
 * project tabs) or has zero dimensions — the SCSS-default position
 * stays in effect. Mirrors `permissionOverlay.tsx`'s positioning math
 * (HS-7266) and `terminalPromptOverlay.tsx`'s (HS-8012); pulled here
 * so both surfaces share one impl.
 */
function positionBelowProjectTab(overlay: HTMLElement, projectSecret: string): void {
  const tab = document.querySelector<HTMLElement>(`.project-tab[data-secret="${CSS.escape(projectSecret)}"]`);
  if (tab === null) return;
  const tabRect = tab.getBoundingClientRect();
  if (tabRect.width === 0 && tabRect.height === 0) return; // hidden
  const popupRect = overlay.getBoundingClientRect();
  const maxLeft = Math.max(8, window.innerWidth - popupRect.width - 8);
  overlay.style.top = `${tabRect.bottom + 4}px`;
  overlay.style.left = `${Math.min(Math.max(8, tabRect.left), maxLeft)}px`;
  // Disable the SCSS-default centering transform so the popup
  // actually lands at `tabRect.left` instead of `left + translateX(-50%)`.
  overlay.style.transform = 'none';
}

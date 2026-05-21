/**
 * HS-8221 — Drawer-terminal-tab right-click context menu, extracted from
 * `terminal.tsx`.
 *
 * The menu offers Close Tab / Close Other Tabs / Close Tabs to the Left /
 * Close Tabs to the Right / Rename... entries. Configured (default)
 * terminals can't be closed, so "Close Tab" renders disabled when the
 * clicked tab is configured (the bulk-close actions still work — they
 * skip configured tabs internally).
 *
 * ### API
 * The caller (`terminal.tsx`) owns the per-tab data structures (`instances`
 * Map, `orderedTabIds()` walker, `isDynamic` predicate, the close /
 * rename actions). The new module owns the DOM + viewport-clamp +
 * outside-click-dismiss; the caller passes its actions in via callbacks
 * so the new module stays free of `TerminalInstance` coupling.
 *
 * Pre-fix (HS-8194 deferred this) the menu lived inside `terminal.tsx`
 * with direct access to `instances` / `closeDynamicTerminal` / `closeTabs`
 * / `promptRenameTerminal`. Moving it as-is would have pulled those out
 * too. The callback contract here keeps the surface area small.
 */
import { toElement } from '../dom.js';
import { ICON_CLOSE_LEFT, ICON_CLOSE_OTHERS, ICON_CLOSE_RIGHT, ICON_PENCIL, ICON_X } from '../icons.js';

export interface ShowTabContextMenuOptions {
  /** The triggering MouseEvent — used for x/y placement. */
  event: MouseEvent;
  /** The tab id the user right-clicked. */
  clickedId: string;
  /** True when the clicked tab is a closable (dynamic) tab. Configured
   *  default tabs render Close Tab disabled but the menu still opens. */
  clickedIsDynamic: boolean;
  /** Snapshot of every drawer-tab id in left-to-right order. Captured at
   *  show time so subsequent reorders / closes don't shift the indices
   *  the bulk-close actions resolve. */
  orderedIds: string[];
  /** Predicate the bulk-close actions use to filter out configured tabs. */
  isDynamic: (id: string) => boolean;

  /** Called when the user picks "Close Tab" on a dynamic tab. */
  onClose: (id: string) => void;
  /** Called with the dynamic-tab ids from the bulk-close actions. */
  onCloseSet: (ids: string[]) => void;
  /** Called when the user picks "Rename..." */
  onRename: (id: string) => void;
}

/** Public entry point — mount the right-click context menu near the
 *  triggering pointer. Returns the menu element (so tests can assert /
 *  dispatch follow-up clicks); production callers ignore the return. */
export function showTabContextMenu(opts: ShowTabContextMenuOptions): HTMLElement {
  dismissTabContextMenu();

  // HS-7835 — Lucide icons on every entry.
  const menu = toElement(
    <div className="terminal-tab-context-menu command-log-context-menu" style={`left:${opts.event.clientX}px;top:${opts.event.clientY}px`}>
      <div className={`context-menu-item${opts.clickedIsDynamic ? '' : ' disabled'}`} data-action="close">
        <span className="dropdown-icon">{ICON_X}</span>
        <span className="context-menu-label">Close Tab</span>
      </div>
      <div className="context-menu-item" data-action="close-others">
        <span className="dropdown-icon">{ICON_CLOSE_OTHERS}</span>
        <span className="context-menu-label">Close Other Tabs</span>
      </div>
      <div className="context-menu-item" data-action="close-left">
        <span className="dropdown-icon">{ICON_CLOSE_LEFT}</span>
        <span className="context-menu-label">Close Tabs to the Left</span>
      </div>
      <div className="context-menu-item" data-action="close-right">
        <span className="dropdown-icon">{ICON_CLOSE_RIGHT}</span>
        <span className="context-menu-label">Close Tabs to the Right</span>
      </div>
      <div className="context-menu-separator"></div>
      <div className="context-menu-item" data-action="rename">
        <span className="dropdown-icon">{ICON_PENCIL}</span>
        <span className="context-menu-label">Rename...</span>
      </div>
    </div>
  );

  const bind = (action: string, handler: () => void): void => {
    const el = menu.querySelector<HTMLElement>(`[data-action="${action}"]`);
    if (!el) return;
    if (el.classList.contains('disabled')) return;
    el.addEventListener('click', () => {
      dismissTabContextMenu();
      handler();
    });
  };

  bind('close', () => { opts.onClose(opts.clickedId); });
  bind('close-others', () => {
    opts.onCloseSet(opts.orderedIds.filter(id => id !== opts.clickedId && opts.isDynamic(id)));
  });
  bind('close-left', () => {
    const idx = opts.orderedIds.indexOf(opts.clickedId);
    if (idx < 0) return;
    opts.onCloseSet(opts.orderedIds.slice(0, idx).filter(opts.isDynamic));
  });
  bind('close-right', () => {
    const idx = opts.orderedIds.indexOf(opts.clickedId);
    if (idx < 0) return;
    opts.onCloseSet(opts.orderedIds.slice(idx + 1).filter(opts.isDynamic));
  });
  bind('rename', () => { opts.onRename(opts.clickedId); });

  document.body.appendChild(menu);

  // Clamp to viewport.
  const rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 4}px`;
  if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 4}px`;

  // setTimeout(0) so the same click that opened the menu doesn't immediately
  // hit the outside-click handler. After that, any click / contextmenu
  // outside the menu DOM dismisses.
  setTimeout(() => {
    const close = (ev: MouseEvent): void => {
      if (!menu.contains(ev.target as Node)) {
        dismissTabContextMenu();
        document.removeEventListener('click', close, true);
        document.removeEventListener('contextmenu', close, true);
      }
    };
    document.addEventListener('click', close, true);
    document.addEventListener('contextmenu', close, true);
  }, 0);

  return menu;
}

/** Tear down any currently-mounted tab context menu. Idempotent. */
export function dismissTabContextMenu(): void {
  document.querySelector('.terminal-tab-context-menu')?.remove();
}

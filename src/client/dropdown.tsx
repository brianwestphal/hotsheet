import type { SafeHtml } from 'kerfjs';
import { raw } from 'kerfjs';
import type { OverlayHandle } from 'kerfjs/overlay';
import { popover } from 'kerfjs/overlay';

export interface DropdownItem {
  label: string;
  key: string;
  shortcut?: string;
  color?: string;
  /** Icon as JSX (`SafeHtml`) or a raw HTML string. The JSX form is
   *  the preferred path — `{ICON_X}` from `./icons.tsx` plugs in
   *  directly. The legacy string form is preserved for dynamic
   *  callsites (plugin-supplied icon SVG strings, status/priority
   *  helpers that still return strings) until they migrate to JSX. */
  icon?: string | SafeHtml;
  iconColor?: string;
  active?: boolean;
  separator?: boolean;
  action: () => void;
}

/** Open dropdowns, tracked so `closeAllMenus()` can tear them down through
 *  kerf's `close()` (which also drops the reposition listeners). */
const openDropdowns = new Set<OverlayHandle>();

/**
 * KERF-EVAL (feature 9) — anchored menu on kerf 4.2's `popover()` engine. kerf
 * owns the positioning (below the anchor, flipping above on overflow, clamped
 * horizontally), the outside-click dismissal (anchor exempt), AND reposition on
 * scroll/resize — replacing the hand-rolled `positionDropdown` + outside-click +
 * timeout dance. The wrapper carries the `.dropdown-menu` class and the item
 * buttons mount as its direct children, so the existing SCSS is unchanged. This
 * module keeps only the app-specific keyboard SHORTCUT dispatch (press an item's
 * `key` to run it) — kerf handles Escape via `dismiss`.
 *
 * KERF-EVAL (kerf 4.3.0-beta.1) — `native: true` hosts the menu in the browser
 * **top layer** via the Popover API (`[popover]` + `showPopover()`) where the
 * engine supports it (Playwright's Chromium + Tauri's WKWebView both do),
 * feature-detected with a safe fallback to today's plain `<div>`. Context menus
 * open inside scrollable / stacking-context ancestors (the sidebar, the terminal
 * drawer, the tile grid), and the top layer makes the menu immune to
 * `overflow`-ancestor clipping and z-index races — the exact bug class an anchored
 * menu is prone to. No SCSS change: `.dropdown-menu` already fully specifies its
 * own chrome (position/background/border/padding/radius), so the UA `[popover]`
 * defaults (border/padding/`canvas` background/centering) are all overridden.
 */
export function createDropdown(anchor: HTMLElement, items: DropdownItem[]): void {
  const content = (
    <>
      {items.map(item =>
        item.separator === true
          ? <div className="dropdown-separator"></div>
          : <button className={`dropdown-item${item.active === true ? ' active' : ''}`} data-key={item.key}>
              {item.color !== undefined && item.color !== '' ? <span className="dropdown-dot" style={`background-color:${item.color}`}></span> : null}
              {item.icon !== undefined && item.icon !== '' ? <span className="dropdown-icon" style={item.iconColor !== undefined && item.iconColor !== '' ? `color:${item.iconColor}` : ''}>{
                  // eslint-disable-next-line kerfjs/no-raw-with-dynamic-arg -- legacy string-icon callers (plugin-supplied icons, status/priority helpers) still pass HTML strings; JSX-icon callers pass `SafeHtml` which renders via the standard JSX child path.
                  typeof item.icon === 'string' ? raw(item.icon) : item.icon
                }</span> : null}
              <span className="dropdown-label">{item.label}</span>
              {item.shortcut !== undefined && item.shortcut !== '' ? <kbd className="dropdown-kbd">{item.shortcut}</kbd> : null}
            </button>
      )}
    </>
  );

  const handle = popover(anchor, content, {
    className: 'dropdown-menu',
    dismiss: ['outside', 'escape'],
    outsideIgnore: anchor,
    native: true,
  });
  openDropdowns.add(handle);

  // Bind click handlers to each button (skip separators).
  const actionItems = items.filter(i => i.separator !== true);
  handle.el.querySelectorAll('.dropdown-item').forEach((btn, i) => {
    btn.addEventListener('click', () => {
      actionItems[i].action();
      handle.close();
    });
  });

  // App-specific: press an item's shortcut `key` to invoke it (kerf owns Escape).
  const onKeydown = (e: KeyboardEvent): void => {
    const match = items.find(item => item.separator !== true && e.key.toLowerCase() === item.key.toLowerCase());
    if (match) {
      e.preventDefault();
      e.stopPropagation();
      match.action();
      handle.close();
    }
  };
  document.addEventListener('keydown', onKeydown, true);
  void handle.result.finally(() => {
    document.removeEventListener('keydown', onKeydown, true);
    openDropdowns.delete(handle);
  });
}

export function closeAllMenus(): void {
  for (const handle of [...openDropdowns]) handle.close();
}

import type { SafeHtml } from '../jsx-runtime.js';
import { raw } from '../jsx-runtime.js';
import { toElement } from './dom.js';

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

export function positionDropdown(menu: HTMLElement, anchor: HTMLElement) {
  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let left = rect.left;
  if (left + menuRect.width > vw - 8) left = rect.right - menuRect.width;
  if (left < 8) left = 8;

  let top = rect.bottom + 4;
  if (top + menuRect.height > vh - 8) top = rect.top - menuRect.height - 4;
  if (top < 8) top = 8;

  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

export function createDropdown(_anchor: HTMLElement, items: DropdownItem[]): HTMLElement {
  const menu = toElement(
    <div className="dropdown-menu" style="visibility:hidden;top:0;left:0">
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
    </div>
  );

  // Bind click handlers to each button (skip separators)
  const actionItems = items.filter(i => i.separator !== true);
  const buttons = menu.querySelectorAll('.dropdown-item');
  buttons.forEach((btn, i) => {
    btn.addEventListener('click', () => {
      actionItems[i].action();
      menu.remove();
    });
  });

  function onKeydown(e: KeyboardEvent) {
    const match = items.find(item => e.key.toLowerCase() === item.key.toLowerCase());
    if (match) {
      e.preventDefault();
      e.stopPropagation();
      match.action();
      cleanup();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      cleanup();
    }
  }

  function cleanup() {
    menu.remove();
    document.removeEventListener('keydown', onKeydown, true);
    document.removeEventListener('click', onOutsideClick);
  }

  function onOutsideClick() {
    cleanup();
  }

  document.addEventListener('keydown', onKeydown, true);
  setTimeout(() => {
    document.addEventListener('click', onOutsideClick);
  }, 0);

  return menu;
}

export function closeAllMenus() {
  document.querySelectorAll('.dropdown-menu').forEach(m => { m.remove(); });
}

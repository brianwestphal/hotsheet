import { raw } from '../jsx-runtime.js';
import { toElement } from './dom.js';

export interface DropdownItem {
  label: string;
  key: string;
  shortcut?: string;
  color?: string;
  icon?: string;
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
        item.separator
          ? <div className="dropdown-separator"></div>
          : <button className={`dropdown-item${item.active ? ' active' : ''}`} data-key={item.key}>
              {item.color ? <span className="dropdown-dot" style={`background-color:${item.color}`}></span> : null}
              {item.icon ? <span className="dropdown-icon" style={item.iconColor ? `color:${item.iconColor}` : ''}>{raw(item.icon)}</span> : null}
              <span className="dropdown-label">{item.label}</span>
              {item.shortcut ? <kbd className="dropdown-kbd">{item.shortcut}</kbd> : null}
            </button>
      )}
    </div>
  );

  // Bind click handlers to each button (skip separators)
  const actionItems = items.filter(i => !i.separator);
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

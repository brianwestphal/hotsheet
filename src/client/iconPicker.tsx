import { raw } from '../jsx-runtime.js';
import { toElement } from './dom.js';
import {
  CMD_COLORS,
  CMD_ICONS,
  type ItemRef,
  resolveCommand,
  saveCommandItems,
  updateCommand,
} from './experimentalSettings.js';
import { renderIconSvg } from './icons.js';

/** Position a popup below an anchor element, clamped to viewport. */
function positionPopup(popup: HTMLElement, anchor: HTMLElement) {
  popup.style.position = 'fixed';
  popup.style.zIndex = '3000';
  document.body.appendChild(popup);
  const popupRect = popup.getBoundingClientRect();
  const rect = anchor.getBoundingClientRect();
  let top = rect.bottom + 4;
  if (top + popupRect.height > window.innerHeight - 8) top = rect.top - popupRect.height - 4;
  popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popupRect.width - 8))}px`;
  popup.style.top = `${Math.max(8, top)}px`;
}

/** Close a popup on outside click. */
function closeOnOutsideClick(popup: HTMLElement) {
  setTimeout(() => {
    const close = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node)) { popup.remove(); document.removeEventListener('click', close); }
    };
    document.addEventListener('click', close);
  }, 0);
}

export function showColorDropdown(anchor: HTMLElement, ref: ItemRef) {
  document.querySelectorAll('.color-dropdown-popup').forEach(p => p.remove());
  const cmd = resolveCommand(ref);
  const popup = toElement(
    <div className="color-dropdown-popup">
      {CMD_COLORS.map(c =>
        <button className={`color-dropdown-item${(cmd.color ?? CMD_COLORS[0].value) === c.value ? ' active' : ''}`} data-color={c.value}>
          <span className="command-color-swatch" style={`background:${c.value}`}></span>
          <span>{c.label}</span>
        </button>
      )}
    </div>
  );
  popup.querySelectorAll('.color-dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      const color = (item as HTMLElement).dataset.color!;
      updateCommand(ref, c => { c.color = color; });
      anchor.style.background = color;
      popup.remove();
      void saveCommandItems();
    });
  });
  positionPopup(popup, anchor);
  closeOnOutsideClick(popup);
}

export function showIconPicker(anchor: HTMLElement, ref: ItemRef) {
  document.querySelectorAll('.icon-picker-popup').forEach(p => p.remove());

  const popup = toElement(
    <div className="icon-picker-popup">
      <input type="text" className="icon-picker-search" placeholder="Search icons..." />
      <div className="icon-picker-grid"></div>
    </div>
  );

  const grid = popup.querySelector('.icon-picker-grid') as HTMLElement;
  const searchInput = popup.querySelector('.icon-picker-search') as HTMLInputElement;

  const FEATURED = ['terminal', 'git-commit', 'git-branch', 'git-pull-request', 'code', 'play', 'send', 'upload', 'download', 'refresh-cw', 'check', 'save', 'rocket', 'zap', 'search', 'file-text', 'clipboard', 'trash', 'edit', 'settings', 'bug', 'test-tube', 'database', 'lock'];

  const cmd = resolveCommand(ref);

  function renderIcons(filter = '') {
    grid.innerHTML = '';
    let icons: typeof CMD_ICONS;
    if (filter) {
      icons = CMD_ICONS.filter(ic => ic.name.includes(filter.toLowerCase()));
    } else {
      const featured = FEATURED.map(name => CMD_ICONS.find(ic => ic.name === name)).filter(Boolean) as typeof CMD_ICONS;
      const sep = toElement(<div className="icon-picker-separator"></div>);
      addIconButtons(featured);
      grid.appendChild(sep);
      icons = CMD_ICONS.filter(ic => !FEATURED.includes(ic.name));
    }
    addIconButtons(icons);
  }

  function addIconButtons(icons: typeof CMD_ICONS) {
    for (const ic of icons) {
      const btn = toElement(
        <button className={`icon-picker-item${cmd.icon === ic.name ? ' active' : ''}`} title={ic.name}>
          {raw(renderIconSvg(ic.svg, 18))}
        </button>
      );
      btn.addEventListener('click', () => {
        updateCommand(ref, c => { c.icon = ic.name; });
        anchor.innerHTML = renderIconSvg(ic.svg, 16);
        popup.remove();
        void saveCommandItems();
      });
      grid.appendChild(btn);
    }
  }

  renderIcons();
  searchInput.addEventListener('input', () => renderIcons(searchInput.value));

  positionPopup(popup, anchor);
  searchInput.focus();
  closeOnOutsideClick(popup);
}

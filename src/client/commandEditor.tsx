import { raw } from '../jsx-runtime.js';
import { toElement } from './dom.js';
import {
  CMD_COLORS,
  CMD_ICONS,
  type CommandGroup,
  type CommandItem,
  contrastColor,
  type CustomCommand,
  deleteAtRef,
  getCommandItems,
  isChannelEnabled,
  isGroup,
  type ItemRef,
  resolveCommand,
  saveCommandItems,
  updateCommand,
} from './experimentalSettings.js';
import { renderIconSvg } from './icons.js';

function showColorDropdown(anchor: HTMLElement, ref: ItemRef) {
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
  const rect = anchor.getBoundingClientRect();
  popup.style.position = 'fixed';
  popup.style.zIndex = '3000';
  document.body.appendChild(popup);
  // Clamp to viewport
  const popupRect = popup.getBoundingClientRect();
  let top = rect.bottom + 4;
  if (top + popupRect.height > window.innerHeight - 8) top = rect.top - popupRect.height - 4;
  popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popupRect.width - 8))}px`;
  popup.style.top = `${Math.max(8, top)}px`;
  setTimeout(() => {
    const close = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node)) { popup.remove(); document.removeEventListener('click', close); }
    };
    document.addEventListener('click', close);
  }, 0);
}

function showIconPicker(anchor: HTMLElement, ref: ItemRef) {
  // Remove any existing picker
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
      // Show featured icons first, then a separator, then all
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

  // Position below anchor, clamped to viewport
  const rect = anchor.getBoundingClientRect();
  popup.style.position = 'fixed';
  popup.style.zIndex = '3000';
  document.body.appendChild(popup);
  const popupRect = popup.getBoundingClientRect();
  let top = rect.bottom + 4;
  if (top + popupRect.height > window.innerHeight - 8) top = rect.top - popupRect.height - 4;
  popup.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - popupRect.width - 8))}px`;
  popup.style.top = `${Math.max(8, top)}px`;
  searchInput.focus();

  // Close on outside click
  setTimeout(() => {
    const close = (e: MouseEvent) => {
      if (!popup.contains(e.target as Node)) { popup.remove(); document.removeEventListener('click', close); }
    };
    document.addEventListener('click', close);
  }, 0);
}

/** Show the command editor as a modal dialog overlay. */
export function showCommandEditorModal(ref: ItemRef) {
  // Remove any existing modal
  document.querySelectorAll('.cmd-editor-overlay').forEach(el => el.remove());

  const cmd = resolveCommand(ref);
  const currentIcon = CMD_ICONS.find(ic => ic.name === cmd.icon) || CMD_ICONS[0];
  const currentColor = cmd.color ?? CMD_COLORS[0].value;
  const currentTarget = cmd.target ?? 'claude';
  const promptLabel = currentTarget === 'shell' ? 'Shell command to run:' : 'Prompt sent to Claude:';
  const promptPlaceholder = currentTarget === 'shell' ? 'e.g. npm run build' : 'Tell Claude what to do...';

  const overlay = toElement(
    <div className="cmd-editor-overlay">
      <div className="cmd-editor-dialog">
        <div className="cmd-editor-dialog-header">
          <span>Edit Command</span>
          <button className="cmd-editor-close-btn" title="Close">{'\u00D7'}</button>
        </div>
        <div className="cmd-editor-dialog-body">
          <div className="settings-command-row-header">
            <button className="command-color-dropdown-btn" title="Choose color" style={`background:${currentColor}`}></button>
            <button className="command-icon-picker-btn" title="Choose icon">{raw(renderIconSvg(currentIcon.svg, 16))}</button>
            <input type="text" value={cmd.name} placeholder="Button label..." />
          </div>
          <div className="command-target-segmented">
            <button className={`seg-btn${currentTarget === 'claude' ? ' active' : ''}`} data-target="claude">Claude Code</button>
            <button className={`seg-btn${currentTarget === 'shell' ? ' active' : ''}`} data-target="shell">Shell</button>
          </div>
          <label className="command-prompt-label">{promptLabel}</label>
          <textarea placeholder={promptPlaceholder}>{cmd.prompt}</textarea>
          <label className="command-auto-show-label" style={currentTarget === 'shell' ? '' : 'display:none'}>
            <input type="checkbox" className="command-auto-show" checked={cmd.autoShowLog === true} /> Show log on completion
          </label>
          <div className="command-claude-warning" style={currentTarget !== 'shell' && !isChannelEnabled() ? '' : 'display:none'}>
            {'\u26A0'} This command won't appear in the sidebar unless Claude Channel is enabled above.
          </div>
        </div>
        <div className="cmd-editor-dialog-footer">
          <button className="btn btn-sm cmd-editor-done-btn">Done</button>
        </div>
      </div>
    </div>
  );

  const closeModal = () => {
    overlay.remove();
    renderCustomCommandSettings();
  };

  // Close button
  overlay.querySelector('.cmd-editor-close-btn')!.addEventListener('click', closeModal);
  // Done button
  overlay.querySelector('.cmd-editor-done-btn')!.addEventListener('click', closeModal);
  // Click outside dialog to close
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeModal();
  });

  const nameInput = overlay.querySelector('.settings-command-row-header input[type="text"]') as HTMLInputElement;
  const promptArea = overlay.querySelector('textarea') as HTMLTextAreaElement;
  const segBtns = overlay.querySelectorAll('.seg-btn');
  const promptLabelEl = overlay.querySelector('.command-prompt-label') as HTMLElement;
  const autoShowLabel = overlay.querySelector('.command-auto-show-label') as HTMLElement;
  const autoShowCheckbox = overlay.querySelector('.command-auto-show') as HTMLInputElement;
  const claudeWarning = overlay.querySelector('.command-claude-warning') as HTMLElement;

  const save = () => {
    updateCommand(ref, c => {
      c.name = nameInput.value;
      c.prompt = promptArea.value;
    });
    void saveCommandItems();
  };

  nameInput.addEventListener('input', save);
  promptArea.addEventListener('input', save);

  autoShowCheckbox.addEventListener('change', () => {
    updateCommand(ref, c => { c.autoShowLog = autoShowCheckbox.checked; });
    void saveCommandItems();
  });

  for (const segBtn of segBtns) {
    segBtn.addEventListener('click', () => {
      const target = (segBtn as HTMLElement).dataset.target as 'claude' | 'shell';
      for (const b of segBtns) b.classList.remove('active');
      segBtn.classList.add('active');
      updateCommand(ref, c => { c.target = target === 'claude' ? undefined : target; });
      promptLabelEl.textContent = target === 'shell' ? 'Shell command to run:' : 'Prompt sent to Claude:';
      promptArea.placeholder = target === 'shell' ? 'e.g. npm run build' : 'Tell Claude what to do...';
      autoShowLabel.style.display = target === 'shell' ? '' : 'none';
      claudeWarning.style.display = target !== 'shell' && !isChannelEnabled() ? '' : 'none';
      void saveCommandItems();
    });
  }

  // Color dropdown
  const colorBtn = overlay.querySelector('.command-color-dropdown-btn') as HTMLElement;
  colorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    showColorDropdown(colorBtn, ref);
  });

  // Icon picker
  overlay.querySelector('.command-icon-picker-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    showIconPicker(overlay.querySelector('.command-icon-picker-btn') as HTMLElement, ref);
  });

  document.body.appendChild(overlay);
  nameInput.focus();
}

// --- Outline list rendering and drag-and-drop ---

// Drag state uses ItemRef to track source and target
let draggedRef: ItemRef | null = null;
let dropTargetRef: ItemRef | null = null;
let dropPosition: 'above' | 'below' | 'into-group' | null = null;

function clearAllDropIndicators() {
  document.querySelectorAll('.cmd-outline-row.drop-above').forEach(el => el.classList.remove('drop-above'));
  document.querySelectorAll('.cmd-outline-row.drop-below').forEach(el => el.classList.remove('drop-below'));
  document.querySelectorAll('.cmd-outline-group-row.drop-into').forEach(el => el.classList.remove('drop-into'));
}

function refEqual(a: ItemRef | null, b: ItemRef | null): boolean {
  if (a === null || b === null) return a === b;
  if (a.type === 'top' && b.type === 'top') return a.index === b.index;
  if (a.type === 'child' && b.type === 'child') return a.groupIndex === b.groupIndex && a.childIndex === b.childIndex;
  return false;
}

/** Render the outline row for a command in the settings list. */
function renderCommandOutlineRow(ref: ItemRef): HTMLElement {
  const cmd = resolveCommand(ref);
  const currentIcon = CMD_ICONS.find(ic => ic.name === cmd.icon) || CMD_ICONS[0];
  const currentColor = cmd.color ?? CMD_COLORS[0].value;
  const textColor = contrastColor(currentColor);
  const isChild = ref.type === 'child';

  const row = toElement(
    <div className={`cmd-outline-row${isChild ? ' cmd-outline-indented' : ''}`} draggable="true" data-ref={JSON.stringify(ref)}>
      <span className="command-drag-handle" title="Drag to reorder">{'\u2630'}</span>
      <span className="cmd-outline-icon" style={`background:${currentColor};color:${textColor}`}>{raw(renderIconSvg(currentIcon.svg, 12, textColor))}</span>
      <span className="cmd-outline-name">{cmd.name !== '' ? cmd.name : '(untitled)'}</span>
      <button className="cmd-outline-edit-btn" title="Edit">{raw(renderIconSvg((CMD_ICONS.find(ic => ic.name === 'pencil') || CMD_ICONS[0]).svg, 13))}</button>
      <button className="cmd-outline-delete-btn" title="Delete">{raw(renderIconSvg((CMD_ICONS.find(ic => ic.name === 'trash-2') || CMD_ICONS[0]).svg, 13))}</button>
    </div>
  );

  row.querySelector('.cmd-outline-edit-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    showCommandEditorModal(ref);
  });

  row.querySelector('.cmd-outline-delete-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    deleteAtRef(ref);
    renderCustomCommandSettings();
    void saveCommandItems();
  });

  // Drag and drop reordering
  addDragHandlers(row, ref);

  return row;
}

/** Render the outline row for a group header in the settings list. */
function renderGroupOutlineRow(topIndex: number): HTMLElement {
  const commandItems = getCommandItems();
  const group = commandItems[topIndex] as CommandGroup;
  const ref: ItemRef = { type: 'top', index: topIndex };

  const row = toElement(
    <div className="cmd-outline-row cmd-outline-group-row" draggable="true" data-ref={JSON.stringify(ref)}>
      <span className="command-drag-handle" title="Drag to reorder">{'\u2630'}</span>
      <span className="cmd-outline-group-name" contentEditable="true">{group.name}</span>
      {group.children.length === 0
        ? <button className="cmd-outline-delete-btn" title="Delete empty group">{raw(renderIconSvg((CMD_ICONS.find(ic => ic.name === 'trash-2') || CMD_ICONS[0]).svg, 13))}</button>
        : ''
      }
    </div>
  );

  // Inline editing of group name
  const nameEl = row.querySelector('.cmd-outline-group-name') as HTMLElement;
  nameEl.addEventListener('blur', () => {
    const newName = nameEl.textContent.trim();
    if (newName === '') {
      // Revert to old name if empty
      nameEl.textContent = group.name;
      return;
    }
    if (newName !== group.name) {
      (commandItems[topIndex] as CommandGroup).name = newName;
      void saveCommandItems();
    }
  });
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { nameEl.textContent = group.name; nameEl.blur(); }
  });

  // Delete button (only for empty groups)
  if (group.children.length === 0) {
    row.querySelector('.cmd-outline-delete-btn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      commandItems.splice(topIndex, 1);
      renderCustomCommandSettings();
      void saveCommandItems();
    });
  }

  // Drag and drop
  addDragHandlers(row, ref);

  return row;
}

/** Add drag-and-drop handlers to a row element. */
function addDragHandlers(row: HTMLElement, ref: ItemRef) {
  const commandItems = getCommandItems();
  const item = ref.type === 'top' ? commandItems[ref.index] : resolveCommand(ref);
  const isGroupRow = isGroup(item);

  row.addEventListener('dragstart', (e) => {
    draggedRef = ref;
    e.dataTransfer!.setData('text/plain', JSON.stringify(ref));
    e.dataTransfer!.effectAllowed = 'move';
    setTimeout(() => row.classList.add('dragging'), 0);
  });

  row.addEventListener('dragend', () => {
    row.classList.remove('dragging');
    draggedRef = null;
    dropTargetRef = null;
    dropPosition = null;
    clearAllDropIndicators();
  });

  row.addEventListener('dragover', (e) => {
    if (draggedRef === null || refEqual(draggedRef, ref)) return;
    e.preventDefault();
    e.dataTransfer!.dropEffect = 'move';

    const draggedItem = draggedRef.type === 'top' ? commandItems[draggedRef.index] : resolveCommand(draggedRef);
    const draggedIsGroup = isGroup(draggedItem);

    // Calculate mouse position relative to this row
    const rect = row.getBoundingClientRect();
    const mouseY = e.clientY - rect.top;
    const fraction = mouseY / rect.height;

    clearAllDropIndicators();

    // Group header: if a command is being dragged and mouse is in middle zone, show "drop into"
    if (isGroupRow && !draggedIsGroup && fraction > 0.25 && fraction < 0.75) {
      dropTargetRef = ref;
      dropPosition = 'into-group';
      row.classList.add('drop-into');
    } else if (fraction < 0.5) {
      dropTargetRef = ref;
      dropPosition = 'above';
      row.classList.add('drop-above');
    } else {
      dropTargetRef = ref;
      dropPosition = 'below';
      row.classList.add('drop-below');
    }
  });

  row.addEventListener('dragleave', (e) => {
    // Only clear if actually leaving this row (not entering a child)
    if (row.contains(e.relatedTarget as Node)) return;
    row.classList.remove('drop-above', 'drop-below', 'drop-into');
    if (refEqual(dropTargetRef, ref)) {
      dropTargetRef = null;
      dropPosition = null;
    }
  });

  row.addEventListener('drop', (e) => {
    e.preventDefault();
    clearAllDropIndicators();
    if (draggedRef === null || dropTargetRef === null || dropPosition === null) return;
    if (refEqual(draggedRef, dropTargetRef)) { draggedRef = null; return; }

    const draggedItem = draggedRef.type === 'top' ? commandItems[draggedRef.index] : resolveCommand(draggedRef);
    const draggedIsGroup = isGroup(draggedItem);

    // Validate: groups can't be dropped into groups
    if (draggedIsGroup && dropPosition === 'into-group') {
      draggedRef = null;
      dropTargetRef = null;
      dropPosition = null;
      return;
    }

    // Only commands (not groups) can be dragged; groups can be reordered at top level
    if (draggedIsGroup) {
      // Reorder a group at the top level
      const fromIdx = (draggedRef as { type: 'top'; index: number }).index;
      const [movedGroup] = commandItems.splice(fromIdx, 1);

      // Target must also be top-level for group reordering
      let targetIdx: number;
      if (dropTargetRef.type === 'top') {
        targetIdx = fromIdx < dropTargetRef.index ? dropTargetRef.index - 1 : dropTargetRef.index;
      } else {
        // Dropped on a child row -- treat as dropping at the group's position
        targetIdx = fromIdx < dropTargetRef.groupIndex ? dropTargetRef.groupIndex - 1 : dropTargetRef.groupIndex;
      }
      if (dropPosition === 'below') targetIdx += 1;
      commandItems.splice(targetIdx, 0, movedGroup);
    } else if (dropPosition === 'into-group') {
      // Drop a command into a group
      const cmd = removeCommandAtRef(draggedRef, commandItems);
      // Recalculate target index after removal
      const groupIdx = dropTargetRef.type === 'top' ? dropTargetRef.index : dropTargetRef.groupIndex;
      const adjustedGroupIdx = draggedRef.type === 'top' && draggedRef.index < groupIdx ? groupIdx - 1 : groupIdx;
      (commandItems[adjustedGroupIdx] as CommandGroup).children.splice(0, 0, cmd);
    } else {
      // Positional reorder: above or below target
      if (dropTargetRef.type === 'child') {
        // Dropping near a child item -- insert within the same group
        const cmd = removeCommandAtRef(draggedRef, commandItems);
        const groupIdx = draggedRef.type === 'top' && draggedRef.index < dropTargetRef.groupIndex
          ? dropTargetRef.groupIndex - 1 : dropTargetRef.groupIndex;
        let childIdx = dropTargetRef.childIndex;
        // Same-group child reorder: adjust for the removed child
        if (draggedRef.type === 'child' && draggedRef.groupIndex === dropTargetRef.groupIndex && draggedRef.childIndex < childIdx) {
          childIdx--;
        }
        if (dropPosition === 'below') childIdx++;
        (commandItems[groupIdx] as CommandGroup).children.splice(childIdx, 0, cmd);
      } else {
        // Dropping near a top-level item -- insert at top level
        const cmd = removeCommandAtRef(draggedRef, commandItems);
        let targetIdx = dropTargetRef.index;
        if (draggedRef.type === 'top' && draggedRef.index < targetIdx) targetIdx--;
        if (dropPosition === 'below') targetIdx++;
        commandItems.splice(targetIdx, 0, cmd);
      }
    }

    draggedRef = null;
    dropTargetRef = null;
    dropPosition = null;
    renderCustomCommandSettings();
    void saveCommandItems();
  });
}

/** Remove a command from wherever it lives, returning the command. */
function removeCommandAtRef(ref: ItemRef, commandItems: CommandItem[]): CustomCommand {
  if (ref.type === 'top') {
    return commandItems.splice(ref.index, 1)[0] as CustomCommand;
  }
  const group = commandItems[ref.groupIndex] as CommandGroup;
  return group.children.splice(ref.childIndex, 1)[0];
}

export function renderCustomCommandSettings() {
  const commandItems = getCommandItems();
  const list = document.getElementById('settings-commands-list');
  if (!list) return;
  list.innerHTML = '';

  // Render all top-level items; for groups, also render their children indented
  for (let i = 0; i < commandItems.length; i++) {
    const item = commandItems[i];
    if (isGroup(item)) {
      list.appendChild(renderGroupOutlineRow(i));
      // Render children indented under the group
      for (let j = 0; j < item.children.length; j++) {
        const childRef: ItemRef = { type: 'child', groupIndex: i, childIndex: j };
        list.appendChild(renderCommandOutlineRow(childRef));
      }
    } else {
      const topRef: ItemRef = { type: 'top', index: i };
      list.appendChild(renderCommandOutlineRow(topRef));
    }
  }

  // Add Command and Add Group buttons at the bottom
  const btnRow = toElement(
    <div className="cmd-outline-btn-row">
      <button className="btn btn-sm cmd-outline-add-btn">Add Command</button>
      <button className="btn btn-sm cmd-outline-add-group-btn">Add Group</button>
    </div>
  );

  const channelCheckbox = document.getElementById('settings-channel-enabled') as HTMLInputElement | null;
  btnRow.querySelector('.cmd-outline-add-btn')!.addEventListener('click', () => {
    const defaultTarget = channelCheckbox?.checked === true ? undefined : 'shell' as const;
    commandItems.push({ name: '', prompt: '', target: defaultTarget });
    const newRef: ItemRef = { type: 'top', index: commandItems.length - 1 };
    showCommandEditorModal(newRef);
    renderCustomCommandSettings();
  });

  btnRow.querySelector('.cmd-outline-add-group-btn')!.addEventListener('click', () => {
    commandItems.push({ type: 'group', name: 'New Group', children: [] });
    renderCustomCommandSettings();
    void saveCommandItems();
  });

  list.appendChild(btnRow);
}

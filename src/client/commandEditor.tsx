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
import { showColorDropdown, showIconPicker } from './iconPicker.js';
import { renderIconSvg } from './icons.js';

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

  overlay.querySelector('.cmd-editor-close-btn')!.addEventListener('click', closeModal);
  overlay.querySelector('.cmd-editor-done-btn')!.addEventListener('click', closeModal);
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
    updateCommand(ref, c => { c.name = nameInput.value; c.prompt = promptArea.value; });
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

  const colorBtn = overlay.querySelector('.command-color-dropdown-btn') as HTMLElement;
  colorBtn.addEventListener('click', (e) => { e.stopPropagation(); showColorDropdown(colorBtn, ref); });
  overlay.querySelector('.command-icon-picker-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    showIconPicker(overlay.querySelector('.command-icon-picker-btn') as HTMLElement, ref);
  });

  document.body.appendChild(overlay);
  nameInput.focus();
}

// --- Outline list rendering and drag-and-drop ---

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

  addDragHandlers(row, ref);
  return row;
}

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

  const nameEl = row.querySelector('.cmd-outline-group-name') as HTMLElement;
  nameEl.addEventListener('blur', () => {
    const newName = nameEl.textContent.trim();
    if (newName === '') { nameEl.textContent = group.name; return; }
    if (newName !== group.name) {
      (commandItems[topIndex] as CommandGroup).name = newName;
      void saveCommandItems();
    }
  });
  nameEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (e.key === 'Escape') { nameEl.textContent = group.name; nameEl.blur(); }
  });

  if (group.children.length === 0) {
    row.querySelector('.cmd-outline-delete-btn')!.addEventListener('click', (e) => {
      e.stopPropagation();
      commandItems.splice(topIndex, 1);
      renderCustomCommandSettings();
      void saveCommandItems();
    });
  }

  addDragHandlers(row, ref);
  return row;
}

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

    const rect = row.getBoundingClientRect();
    const fraction = (e.clientY - rect.top) / rect.height;

    clearAllDropIndicators();

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
    if (row.contains(e.relatedTarget as Node)) return;
    row.classList.remove('drop-above', 'drop-below', 'drop-into');
    if (refEqual(dropTargetRef, ref)) { dropTargetRef = null; dropPosition = null; }
  });

  row.addEventListener('drop', (e) => {
    e.preventDefault();
    clearAllDropIndicators();
    if (draggedRef === null || dropTargetRef === null || dropPosition === null) return;
    if (refEqual(draggedRef, dropTargetRef)) { draggedRef = null; return; }

    const draggedItem = draggedRef.type === 'top' ? commandItems[draggedRef.index] : resolveCommand(draggedRef);
    const draggedIsGroup = isGroup(draggedItem);

    if (draggedIsGroup && dropPosition === 'into-group') {
      draggedRef = null; dropTargetRef = null; dropPosition = null;
      return;
    }

    if (draggedIsGroup) {
      const fromIdx = (draggedRef as { type: 'top'; index: number }).index;
      const [movedGroup] = commandItems.splice(fromIdx, 1);
      let targetIdx: number;
      if (dropTargetRef.type === 'top') {
        targetIdx = fromIdx < dropTargetRef.index ? dropTargetRef.index - 1 : dropTargetRef.index;
      } else {
        targetIdx = fromIdx < dropTargetRef.groupIndex ? dropTargetRef.groupIndex - 1 : dropTargetRef.groupIndex;
      }
      if (dropPosition === 'below') targetIdx += 1;
      commandItems.splice(targetIdx, 0, movedGroup);
    } else if (dropPosition === 'into-group') {
      const cmd = removeCommandAtRef(draggedRef, commandItems);
      const groupIdx = dropTargetRef.type === 'top' ? dropTargetRef.index : dropTargetRef.groupIndex;
      const adjustedGroupIdx = draggedRef.type === 'top' && draggedRef.index < groupIdx ? groupIdx - 1 : groupIdx;
      (commandItems[adjustedGroupIdx] as CommandGroup).children.splice(0, 0, cmd);
    } else {
      if (dropTargetRef.type === 'child') {
        const cmd = removeCommandAtRef(draggedRef, commandItems);
        const groupIdx = draggedRef.type === 'top' && draggedRef.index < dropTargetRef.groupIndex
          ? dropTargetRef.groupIndex - 1 : dropTargetRef.groupIndex;
        let childIdx = dropTargetRef.childIndex;
        if (draggedRef.type === 'child' && draggedRef.groupIndex === dropTargetRef.groupIndex && draggedRef.childIndex < childIdx) childIdx--;
        if (dropPosition === 'below') childIdx++;
        (commandItems[groupIdx] as CommandGroup).children.splice(childIdx, 0, cmd);
      } else {
        const cmd = removeCommandAtRef(draggedRef, commandItems);
        let targetIdx = dropTargetRef.index;
        if (draggedRef.type === 'top' && draggedRef.index < targetIdx) targetIdx--;
        if (dropPosition === 'below') targetIdx++;
        commandItems.splice(targetIdx, 0, cmd);
      }
    }

    draggedRef = null; dropTargetRef = null; dropPosition = null;
    renderCustomCommandSettings();
    void saveCommandItems();
  });
}

function removeCommandAtRef(ref: ItemRef, commandItems: CommandItem[]): CustomCommand {
  if (ref.type === 'top') return commandItems.splice(ref.index, 1)[0] as CustomCommand;
  const group = commandItems[ref.groupIndex] as CommandGroup;
  return group.children.splice(ref.childIndex, 1)[0];
}

export function renderCustomCommandSettings() {
  const commandItems = getCommandItems();
  const list = document.getElementById('settings-commands-list');
  if (!list) return;
  list.innerHTML = '';

  for (let i = 0; i < commandItems.length; i++) {
    const item = commandItems[i];
    if (isGroup(item)) {
      list.appendChild(renderGroupOutlineRow(i));
      for (let j = 0; j < item.children.length; j++) {
        list.appendChild(renderCommandOutlineRow({ type: 'child', groupIndex: i, childIndex: j }));
      }
    } else {
      list.appendChild(renderCommandOutlineRow({ type: 'top', index: i }));
    }
  }

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
    showCommandEditorModal({ type: 'top', index: commandItems.length - 1 });
    renderCustomCommandSettings();
  });

  btnRow.querySelector('.cmd-outline-add-group-btn')!.addEventListener('click', () => {
    commandItems.push({ type: 'group', name: 'New Group', children: [] });
    renderCustomCommandSettings();
    void saveCommandItems();
  });

  list.appendChild(btnRow);
}

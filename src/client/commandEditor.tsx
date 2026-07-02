import { byIdOrNull, toElement } from './dom.js';
import {
  CMD_COLORS,
  CMD_ICONS,
  type CommandGroup,
  type CommandItem,
  contrastColor,
  copyCustomCommands,
  type CustomCommand,
  deleteAtRef,
  getCommandMode,
  getCommandOverriddenIds,
  getCommandShared,
  getEditTree,
  getHiddenSharedCommands,
  isChannelEnabled,
  isGroup,
  type ItemRef,
  moveCommandLayer,
  noteCommandItemsMutation,
  pasteCustomCommands,
  resetCommandOverride,
  resolveCommand,
  saveCommandItems,
  unhideCommand,
  updateCommand,
} from './experimentalSettings.js';
import { showColorDropdown, showIconPicker } from './iconPicker.js';
import { ICON_EYE, ICON_EYE_OFF, ICON_UNDO_2,renderIconSvg } from './icons.js';
import { delegate } from './reactive.js';
import { scopeListHintElement } from './settingsScopeList.js';

/** HS-8614 — recover the `ItemRef` a delegated handler should act on from the
 *  row's `data-ref` attribute (`renderCommandOutlineRow` / `renderGroupOutlineRow`
 *  stamp `JSON.stringify(ref)` there). Parses to `unknown` then narrows by hand
 *  so there's no `JSON.parse(x) as ItemRef` wire-boundary cast. Returns null
 *  when `el` isn't inside a row or the payload is malformed. */
function readRef(el: Element): ItemRef | null {
  const raw = el.closest<HTMLElement>('.cmd-outline-row')?.dataset.ref;
  if (raw === undefined) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o.type === 'top' && typeof o.index === 'number') return { type: 'top', index: o.index };
  if (o.type === 'child' && typeof o.groupIndex === 'number' && typeof o.childIndex === 'number') {
    return { type: 'child', groupIndex: o.groupIndex, childIndex: o.childIndex };
  }
  return null;
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
            <button className="command-icon-picker-btn" title="Choose icon">{renderIconSvg(currentIcon.svg, 16)}</button>
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
          {/* HS-8539 — when on, a normal click launches the command in a new
              terminal (default shell). Long-press always does this regardless. */}
          <label className="command-launch-terminal-label" style={currentTarget === 'shell' ? '' : 'display:none'}>
            <input type="checkbox" className="command-launch-terminal" checked={cmd.launchInNewTerminal === true} /> Launch in new terminal
          </label>
          {/* HS-9102 — Claude-only: mark a command idempotent/maintenance-safe so the
              "Run on…" worker picker fans it out to a busy worker without the
              busy-worker confirm (docs/103 §103.2). Shown only for Claude commands —
              worker targets are a Claude-command feature. */}
          <label className="command-worker-safe-label" style={currentTarget === 'shell' ? 'display:none' : ''}>
            <input type="checkbox" className="command-worker-safe" checked={cmd.workerSafe === true} /> Safe to run on busy workers
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
  const launchTerminalLabel = overlay.querySelector('.command-launch-terminal-label') as HTMLElement;
  const launchTerminalCheckbox = overlay.querySelector('.command-launch-terminal') as HTMLInputElement;
  const workerSafeLabel = overlay.querySelector('.command-worker-safe-label') as HTMLElement;
  const workerSafeCheckbox = overlay.querySelector('.command-worker-safe') as HTMLInputElement;
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

  // HS-8539 — per-command "Launch in New Terminal" default.
  launchTerminalCheckbox.addEventListener('change', () => {
    updateCommand(ref, c => { c.launchInNewTerminal = launchTerminalCheckbox.checked; });
    void saveCommandItems();
  });

  // HS-9102 — per-command "Safe to run on busy workers" flag.
  workerSafeCheckbox.addEventListener('change', () => {
    updateCommand(ref, c => { c.workerSafe = workerSafeCheckbox.checked; });
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
      launchTerminalLabel.style.display = target === 'shell' ? '' : 'none';
      workerSafeLabel.style.display = target === 'shell' ? 'none' : ''; // HS-9102 — Claude-only
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

/** HS-9014 - per-render scope context for the rows: the active mode + the set
 *  of ids that live in the SHARED tree (top-level + children), so each row can
 *  show its origin tag + the right move/hide affordance. */
interface ScopeCtx {
  mode: 'shared' | 'local';
  sharedIds: Set<string>;
  overriddenIds: Set<string>; // HS-9184 — shared ids the local layer overrides
}

function buildScopeCtx(): ScopeCtx {
  const sharedIds = new Set<string>();
  for (const item of getCommandShared()) {
    if (typeof item.id === 'string' && item.id !== '') sharedIds.add(item.id);
    if (isGroup(item)) {
      for (const ch of item.children) {
        if (typeof ch.id === 'string' && ch.id !== '') sharedIds.add(ch.id);
      }
    }
  }
  return { mode: getCommandMode(), sharedIds, overriddenIds: getCommandOverriddenIds() };
}

/** Is the item at `ref` a SHARED item (vs a local-only addition)? */
function isSharedItem(item: CommandItem, ctx: ScopeCtx): boolean {
  // HS-9181 — the Shared editor only ever shows shared items, so everything in it
  // is shared (incl. a just-added command not yet folded into `commandShared`).
  // Pre-fix `sharedIds` lagged the editor tree, so a new shared command flashed a
  // "local" tag until the dialog was reopened.
  if (ctx.mode === 'shared') return true;
  return typeof item.id === 'string' && ctx.sharedIds.has(item.id);
}

/** HS-9184 — is this a shared item the local layer currently overrides? */
function isOverriddenItem(item: CommandItem, ctx: ScopeCtx): boolean {
  return ctx.mode === 'local' && typeof item.id === 'string' && ctx.overriddenIds.has(item.id);
}

/** HS-9014 / HS-9094 \u2014 the origin tag + (for an overridden shared item) the
 *  undo-2 reset-to-shared button. HS-9216 \u2014 split out from the move button so
 *  every settings editor uses one canonical action order:
 *  `[tag] \u2192 reset \u2192 edit \u2192 hide/show \u2192 delete \u2192 move`. This renders the leading
 *  `[tag] \u2192 reset`; `renderMoveBtn` renders the trailing `move`. */
function renderScopeTagAndReset(item: CommandItem, ref: ItemRef, ctx: ScopeCtx) {
  const shared = isSharedItem(item, ctx);
  const overridden = isOverriddenItem(item, ctx);
  // HS-9220 \u2014 a shared command edited on this machine reads "overridden" (styled
  // like a local tag), matching the terminals editor (HS-9128); a pristine shared
  // item reads "shared", a local-only addition "local". Pre-fix an overridden
  // command kept the plain "shared" tag, hiding that it carried a local override.
  const tagLabel = overridden ? 'overridden' : shared ? 'shared' : 'local';
  const tagClass = overridden || !shared ? 'scope-tag-local' : 'scope-tag-shared';
  const tag = <span className={`cmd-scope-tag scope-tag ${tagClass}`}><span className="scope-tag-dot" />{tagLabel}</span>;
  // HS-9184 \u2014 a locally-overridden shared command offers an undo-2 "reset to
  // shared" button (discards the local override), mirroring terminals (HS-9128).
  const resetBtn = overridden
    ? <button className="scope-reset-btn cmd-reset-btn" title="Reset to shared (discard the local override)" aria-label="Reset to shared">{ICON_UNDO_2}</button>
    : null;
  return <>{tag}{resetBtn}</>;
}

/** HS-9216 \u2014 the trailing shared\u2194local move (transfer) button, rendered LAST in
 *  the action row (after edit/hide/delete) for cross-editor consistency. Null for
 *  a group row that is a child (groups are never nested, so this never triggers
 *  today \u2014 a top-level group moves whole via `ref.type === 'top'`). */
function renderMoveBtn(item: CommandItem, ref: ItemRef, ctx: ScopeCtx) {
  if (ref.type === 'child' && isGroup(item)) return null;
  const shared = isSharedItem(item, ctx);
  const direction = shared ? 'to-local' : 'to-shared';
  const title = shared ? 'Move to Local (make this machine-only)' : 'Move to Shared (commit for the team)';
  return <button className="cmd-outline-move-btn" data-move={direction} title={title}>{shared ? '\u2193' : '\u2191'}</button>;
}

function renderCommandOutlineRow(ref: ItemRef, ctx: ScopeCtx): HTMLElement {
  const cmd = resolveCommand(ref);
  const currentIcon = CMD_ICONS.find(ic => ic.name === cmd.icon) || CMD_ICONS[0];
  const currentColor = cmd.color ?? CMD_COLORS[0].value;
  const textColor = contrastColor(currentColor);
  const isChild = ref.type === 'child';
  // HS-9014 \u2014 in Local mode, removing a SHARED command hides it on this machine
  // (the delta records it as `hidden`); a local-only addition is truly deleted.
  const shared = isSharedItem(cmd, ctx);
  // HS-9183 \u2014 in Local mode a SHARED command can only be HIDDEN on this machine
  // (an eye-off button), not deleted; a local-only addition keeps the trash delete.
  // Mirrors views + terminals (HS-9186). The `.cmd-outline-delete-btn` handler is
  // unchanged \u2014 `deleteAtRef` + the delta computation turn a shared "delete" into a
  // `hidden` entry; the hidden row then re-renders below.
  const hideHere = ctx.mode === 'local' && shared;
  const deleteTitle = hideHere ? 'Hide on this machine' : 'Delete';
  const deleteIcon = hideHere ? ICON_EYE_OFF : renderIconSvg((CMD_ICONS.find(ic => ic.name === 'trash-2') || CMD_ICONS[0]).svg, 13);

  // HS-8614 \u2014 pure markup. The edit / delete clicks + the drag handlers are
  // delegated once at `#settings-commands-list` (`ensureCommandRowDelegationBound`),
  // reading the `ItemRef` back from `data-ref`. HS-9014 adds the scope tag + move btn.
  return toElement(
    <div className={`cmd-outline-row${isChild ? ' cmd-outline-indented' : ''}`} draggable="true" data-ref={JSON.stringify(ref)}>
      <span className="command-drag-handle" title="Drag to reorder">{'\u2630'}</span>
      <span className="cmd-outline-icon" style={`background:${currentColor};color:${textColor}`}>{renderIconSvg(currentIcon.svg, 12, textColor)}</span>
      <span className="cmd-outline-name">{cmd.name !== '' ? cmd.name : '(untitled)'}</span>
      {/* HS-9216 — canonical action order: [tag] reset → edit → delete/hide → move. */}
      {renderScopeTagAndReset(cmd, ref, ctx)}
      <button className="cmd-outline-edit-btn" title="Edit">{renderIconSvg((CMD_ICONS.find(ic => ic.name === 'pencil') || CMD_ICONS[0]).svg, 13)}</button>
      <button className="cmd-outline-delete-btn" title={deleteTitle} aria-label={deleteTitle}>{deleteIcon}</button>
      {renderMoveBtn(cmd, ref, ctx)}
    </div>
  );
}

/** HS-9183: a dimmed row for a shared command hidden on this machine, with an
 *  eye (restore) button. Mirrors the terminals hidden row. */
function renderHiddenCommandRow(entry: { id: string; name: string }): HTMLElement {
  return toElement(
    <div className="cmd-outline-row cmd-outline-row-hidden" data-cmd-id={entry.id}>
      <span className="cmd-outline-name">{entry.name}</span>
      <span className="cmd-scope-tag scope-tag scope-tag-local"><span className="scope-tag-dot" />hidden</span>
      <button className="scope-reset-btn cmd-reenable-btn" title="Show on this machine" aria-label="Show on this machine">{ICON_EYE}</button>
    </div>
  );
}

function renderGroupOutlineRow(topIndex: number, ctx: ScopeCtx): HTMLElement {
  const commandItems = getEditTree();
  const group = commandItems[topIndex] as CommandGroup;
  const ref: ItemRef = { type: 'top', index: topIndex };
  const shared = isSharedItem(group, ctx);
  const deleteTitle = ctx.mode === 'local' && shared ? 'Hide on this machine' : 'Delete empty group';

  // HS-8614 \u2014 pure markup. The contentEditable name's `blur`/`keydown`, the
  // empty-group delete click, and the drag handlers are all delegated once at
  // `#settings-commands-list` (`ensureCommandRowDelegationBound`). `commandItems`
  // is only read here for the markup; the handlers re-fetch it via
  // `getEditTree()` so they always see the live array.
  return toElement(
    <div className="cmd-outline-row cmd-outline-group-row" draggable="true" data-ref={JSON.stringify(ref)}>
      <span className="command-drag-handle" title="Drag to reorder">{'\u2630'}</span>
      <span className="cmd-outline-group-name" contentEditable="true">{group.name}</span>
      {/* HS-9216 — canonical action order: [tag] reset → (delete if empty) → move. */}
      {renderScopeTagAndReset(group, ref, ctx)}
      {group.children.length === 0
        ? <button className="cmd-outline-delete-btn" title={deleteTitle}>{renderIconSvg((CMD_ICONS.find(ic => ic.name === 'trash-2') || CMD_ICONS[0]).svg, 13)}</button>
        : ''
      }
      {renderMoveBtn(group, ref, ctx)}
    </div>
  );
}

/** Track the element the command-outline delegated handlers are bound to + the
 *  disposers. Same element-identity pattern as `terminalsSettings` (HS-8614):
 *  production binds once against the page-lifetime `#settings-commands-list`;
 *  tests rebuild the DOM, so a changed element identity disposes + re-binds
 *  rather than stacking duplicate listeners. */
let delegatedCommandList: HTMLElement | null = null;
let commandRowDisposers: (() => void)[] = [];

/** Test-only — drop the delegated listeners + binding marker so the next render
 *  re-binds against a fresh `#settings-commands-list`. */
export function _resetCommandRowDelegationForTests(): void {
  for (const dispose of commandRowDisposers) dispose();
  commandRowDisposers = [];
  delegatedCommandList = null;
}

function ensureCommandRowDelegationBound(list: HTMLElement): void {
  if (delegatedCommandList === list) return;
  for (const dispose of commandRowDisposers) dispose();
  commandRowDisposers = [];
  delegatedCommandList = list;
  const d = commandRowDisposers;

  // Edit button — open the command editor modal for the row's ref.
  d.push(delegate<HTMLElement>(list, 'click', '.cmd-outline-edit-btn', (e, btn) => {
    e.stopPropagation();
    const ref = readRef(btn);
    if (ref !== null) showCommandEditorModal(ref);
  }));

  // Delete button — covers both command rows and empty-group rows.
  // `deleteAtRef({type:'top'})` splices `commandItems[index]`, identical to the
  // pre-fix empty-group delete branch, so one handler serves both. HS-9014 — in
  // Local mode, deleting a SHARED item resolves (via `computeCommandTreeDelta`)
  // to a `hidden` entry rather than a true removal.
  d.push(delegate<HTMLElement>(list, 'click', '.cmd-outline-delete-btn', (e, btn) => {
    e.stopPropagation();
    const ref = readRef(btn);
    if (ref === null) return;
    deleteAtRef(ref);
    renderCustomCommandSettings();
    void saveCommandItems();
  }));

  // HS-9014 / HS-9094 — shared↔local move button (top-level + child rows,
  // Shared/Local mode). `data-move` carries the direction; `moveCommandLayer`
  // edits both layer files then reloads + re-renders the editor.
  d.push(delegate<HTMLElement>(list, 'click', '.cmd-outline-move-btn', (e, btn) => {
    e.stopPropagation();
    const ref = readRef(btn);
    if (ref === null) return;
    const item = ref.type === 'top'
      ? getEditTree()[ref.index]
      : resolveCommand(ref);
    const id = item.id;
    if (typeof id !== 'string' || id === '') return;
    const direction = btn.dataset.move === 'to-shared' ? 'to-shared' : 'to-local';
    void moveCommandLayer(id, direction, ref.type === 'child' ? 'child' : 'top');
  }));

  // HS-9184 — reset a locally-overridden shared command back to the shared value.
  d.push(delegate<HTMLElement>(list, 'click', '.cmd-reset-btn', (e, btn) => {
    e.stopPropagation();
    const ref = readRef(btn);
    if (ref === null) return;
    const item = ref.type === 'top' ? getEditTree()[ref.index] : resolveCommand(ref);
    const id = item.id;
    if (typeof id !== 'string' || id === '') return;
    void resetCommandOverride(id);
  }));

  // HS-9183 — restore (unhide) a shared command hidden on this machine. The
  // dimmed hidden row carries its id in `data-cmd-id` (not a `data-ref` index).
  d.push(delegate<HTMLElement>(list, 'click', '.cmd-reenable-btn', (e, btn) => {
    e.stopPropagation();
    const id = btn.closest<HTMLElement>('.cmd-outline-row-hidden')?.dataset.cmdId;
    if (id !== undefined && id !== '') void unhideCommand(id);
  }));

  // Group name (contentEditable) — commit on blur, Enter blurs, Escape reverts.
  // `blur` is auto-promoted to the capture phase by `delegate`.
  d.push(delegate<HTMLElement>(list, 'blur', '.cmd-outline-group-name', (_e, nameEl) => {
    const ref = readRef(nameEl);
    if (ref === null || ref.type !== 'top') return;
    const group = getEditTree()[ref.index];
    if (!isGroup(group)) return;
    const newName = nameEl.textContent.trim();
    if (newName === '') { nameEl.textContent = group.name; return; }
    if (newName !== group.name) { group.name = newName; void saveCommandItems(); }
  }));
  d.push(delegate<HTMLElement>(list, 'keydown', '.cmd-outline-group-name', (e, nameEl) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
    if (ke.key === 'Escape') {
      const ref = readRef(nameEl);
      if (ref !== null && ref.type === 'top') {
        const group = getEditTree()[ref.index];
        if (isGroup(group)) nameEl.textContent = group.name;
      }
      nameEl.blur();
    }
  }));

  // Drag-to-reorder. Module-level `draggedRef` / `dropTargetRef` / `dropPosition`
  // carry the gesture state across the delegated handlers; each reads the
  // hovered row's ref from `data-ref`. `getEditTree()` is re-fetched inside
  // the handlers so a mid-session reload's fresh array is always honored.
  d.push(delegate<HTMLElement>(list, 'dragstart', '.cmd-outline-row', (e, row) => {
    const ref = readRef(row);
    if (ref === null) return;
    draggedRef = ref;
    const dt = (e as DragEvent).dataTransfer;
    dt?.setData('text/plain', JSON.stringify(ref));
    if (dt !== null) dt.effectAllowed = 'move';
    setTimeout(() => row.classList.add('dragging'), 0);
  }));

  d.push(delegate<HTMLElement>(list, 'dragend', '.cmd-outline-row', (_e, row) => {
    row.classList.remove('dragging');
    draggedRef = null;
    dropTargetRef = null;
    dropPosition = null;
    clearAllDropIndicators();
  }));

  d.push(delegate<HTMLElement>(list, 'dragover', '.cmd-outline-row', (e, row) => {
    const ref = readRef(row);
    if (draggedRef === null || ref === null || refEqual(draggedRef, ref)) return;
    e.preventDefault();
    const commandItems = getEditTree();
    const dt = (e as DragEvent).dataTransfer;
    if (dt !== null) dt.dropEffect = 'move';

    const item = ref.type === 'top' ? commandItems[ref.index] : resolveCommand(ref);
    const isGroupRow = isGroup(item);
    const draggedItem = draggedRef.type === 'top' ? commandItems[draggedRef.index] : resolveCommand(draggedRef);
    const draggedIsGroup = isGroup(draggedItem);

    const rect = row.getBoundingClientRect();
    const fraction = ((e as DragEvent).clientY - rect.top) / rect.height;

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
  }));

  d.push(delegate<HTMLElement>(list, 'dragleave', '.cmd-outline-row', (e, row) => {
    const related = (e as DragEvent).relatedTarget;
    if (related instanceof Node && row.contains(related)) return;
    row.classList.remove('drop-above', 'drop-below', 'drop-into');
    if (refEqual(dropTargetRef, readRef(row))) { dropTargetRef = null; dropPosition = null; }
  }));

  d.push(delegate<HTMLElement>(list, 'drop', '.cmd-outline-row', (e) => {
    e.preventDefault();
    clearAllDropIndicators();
    if (draggedRef === null || dropTargetRef === null || dropPosition === null) return;
    if (refEqual(draggedRef, dropTargetRef)) { draggedRef = null; return; }

    const commandItems = getEditTree();
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
  }));
}

function removeCommandAtRef(ref: ItemRef, commandItems: CommandItem[]): CustomCommand {
  if (ref.type === 'top') return commandItems.splice(ref.index, 1)[0] as CustomCommand;
  const group = commandItems[ref.groupIndex] as CommandGroup;
  return group.children.splice(ref.childIndex, 1)[0];
}

export function renderCustomCommandSettings() {
  const commandItems = getEditTree();
  const list = byIdOrNull('settings-commands-list');
  if (!list) return;
  ensureCommandRowDelegationBound(list);

  // HS-8614 — accumulate every child then commit via one `replaceChildren`
  // (was `innerHTML = '' + append-each`). Rows are pure markup; the per-row
  // listeners are delegated once at `list` above.
  // HS-9014 — origin tags + the scope hint banner reflect the active mode.
  const ctx = buildScopeCtx();
  const children: Element[] = [];
  children.push(scopeListHintElement(ctx.mode));
  for (let i = 0; i < commandItems.length; i++) {
    const item = commandItems[i];
    if (isGroup(item)) {
      children.push(renderGroupOutlineRow(i, ctx));
      for (let j = 0; j < item.children.length; j++) {
        children.push(renderCommandOutlineRow({ type: 'child', groupIndex: i, childIndex: j }, ctx));
      }
    } else {
      children.push(renderCommandOutlineRow({ type: 'top', index: i }, ctx));
    }
  }

  // HS-9183 — append the shared commands HIDDEN on this machine (Local mode) as
  // dimmed rows with a restore (eye) button, so they don't just vanish.
  for (const hidden of getHiddenSharedCommands()) {
    children.push(renderHiddenCommandRow(hidden));
  }

  const btnRow = toElement(
    <div className="cmd-outline-btn-row">
      <button className="btn btn-sm cmd-outline-add-btn">Add Command</button>
      <button className="btn btn-sm cmd-outline-add-group-btn">Add Group</button>
      {/* HS-8857 — copy/paste the command tree (as JSON) between projects. */}
      <button className="btn btn-sm cmd-outline-copy-btn" title="Copy these custom commands to the clipboard (JSON)">Copy</button>
      <button className="btn btn-sm cmd-outline-paste-btn" title="Paste custom commands from the clipboard (merges into this project)">Paste</button>
    </div>
  );
  btnRow.querySelector('.cmd-outline-copy-btn')!.addEventListener('click', () => { copyCustomCommands(); });
  btnRow.querySelector('.cmd-outline-paste-btn')!.addEventListener('click', () => { void pasteCustomCommands(); });

  const channelCheckbox = byIdOrNull<HTMLInputElement>('settings-channel-enabled');
  btnRow.querySelector('.cmd-outline-add-btn')!.addEventListener('click', () => {
    const defaultTarget = channelCheckbox?.checked === true ? undefined : 'shell' as const;
    // HS-9065 — push onto the LIVE module array (`getEditTree()`), not the
    // `commandItems` captured when this row was rendered. A `reloadCustomCommands`
    // (e.g. the one fired on settings-open) REASSIGNS the module array, so a click
    // landing on a row built against the pre-reload array would push to a now-
    // detached array while `showCommandEditorModal`/`resolveCommand` read the live
    // one — `commandItems[index]` is then `undefined` and the modal crashes on
    // `cmd.icon`. Reading it fresh keeps the push + the ItemRef index consistent.
    const items = getEditTree();
    items.push({ name: '', prompt: '', target: defaultTarget });
    // HS-8440 — the Add Command path mutates `commandItems` synchronously
    // but defers the `saveCommandItems` PATCH until the user clicks Save
    // inside the modal. Without an explicit epoch bump here a still-in-
    // flight `reloadCustomCommands` could resolve between this push and
    // the modal-save, blow away the just-pushed command, and leave the
    // user's typed-out form pointing at a stale `ItemRef`.
    noteCommandItemsMutation();
    showCommandEditorModal({ type: 'top', index: items.length - 1 });
    renderCustomCommandSettings();
  });

  btnRow.querySelector('.cmd-outline-add-group-btn')!.addEventListener('click', () => {
    // HS-9065 — same live-array reasoning as the Add Command handler above.
    getEditTree().push({ type: 'group', name: 'New Group', children: [] });
    renderCustomCommandSettings();
    void saveCommandItems();
  });

  // The btnRow keeps per-element click listeners: it's a single (non-row)
  // element rebuilt fresh on every render, so there's no stale-closure or
  // re-attach-waste concern the per-row delegation addresses.
  children.push(btnRow);
  list.replaceChildren(...children);
}

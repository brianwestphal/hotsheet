# 16. Command Groups

Custom commands can be organized into named groups that appear as collapsible sections in the sidebar and as grouped sections in the settings editor.

## 16.1 Overview

Commands and groups are stored as an ordered list of `CommandItem` entries. A `CommandItem` is either a `CustomCommand` (a button) or a `CommandGroup` (a section header with an explicit `children` array). Groups contain their children explicitly, not positionally. Ungrouped commands appear at the top level before or between groups.

## 16.2 Data Model

```typescript
interface CustomCommand {
  name: string;
  prompt: string;
  icon?: string;
  color?: string;
  target?: 'claude' | 'shell';
  autoShowLog?: boolean;
}

interface CommandGroup {
  type: 'group';
  name: string;
  collapsed?: boolean;  // persisted collapse state
  children: CustomCommand[];  // commands explicitly in this group
}

type CommandItem = CustomCommand | CommandGroup;

function isGroup(item: CommandItem): item is CommandGroup {
  return 'type' in item && item.type === 'group';
}
```

- **Storage**: The `custom_commands` setting stores a JSON-encoded `CommandItem[]`
- **Group membership**: Each `CommandGroup` contains its member commands in the `children` array. Top-level `CustomCommand` entries in the list are ungrouped.
- **Collapse state**: The `collapsed` field on `CommandGroup` is persisted and updated when the user toggles a group in the sidebar

## 16.3 Migration from Old Format

The previous format used a `group` string field on each `CustomCommand`. On load, old-format data is auto-migrated:

1. Commands without a `group` (or empty string) are placed at the top as ungrouped
2. For each distinct group name (in order of first appearance), a `CommandGroup` is created with matching commands in its `children` array
3. The `group` field is stripped from all commands

This migration runs transparently on load and the new format is saved on next edit.

## 16.4 Sidebar Display

In the sidebar (`#channel-commands-container`), items render in array order:

1. **Ungrouped commands** (top-level `CustomCommand` entries) appear as flat buttons
2. **Group headers** render as clickable collapsible sections with a disclosure triangle and the group name
3. **Commands within a group** (from the group's `children` array) render inside the collapsible body

Groups with no visible commands (empty `children`, or all children filtered out) are hidden. Clicking a group header toggles between expanded and collapsed. The `collapsed` field is updated in the persisted data.

## 16.5 Settings Editor

### Outline View (default)

A flat list showing all items in order:

- **Group headers** shown as bold uppercase section rows with:
  - Drag handle (for reorder)
  - Editable group name (click to edit inline via contentEditable)
  - Delete button (only shown for empty groups — groups with commands cannot be deleted)

- **Commands** shown as compact rows with:
  - Drag handle (for reorder)
  - Small icon with background color
  - Command name
  - Edit button (pencil icon) — opens the modal editor
  - Delete button (trash icon)
  - Commands within a group are indented slightly

All items are drag-reorderable. Dragging a command into or out of a group changes its group membership (moves it between the group's `children` array and the top-level list).

Two buttons at the bottom:
- **Add Command** — adds a new command and opens the modal editor
- **Add Group** — adds a new group header named "New Group"

### Command Editor Modal

Clicking "Edit" on any command opens a **modal dialog overlay** containing:

- Color picker button
- Icon picker button
- Name text input
- Target toggle (Claude Code / Shell)
- Prompt/command textarea
- Auto-show log checkbox (visible when target is Shell)
- Claude Channel warning (visible when target is Claude and channel is disabled)

The modal has a "Done" button and close button. Clicking outside the dialog also closes it. Changes save automatically on each edit.

**No group selector** — group membership is determined by the command's position in the `children` array of a group, or at the top level if ungrouped.

## 16.6 Group Name Editing

Clicking the group name text in the outline view activates inline editing (contentEditable). Press Enter or blur to save. Press Escape to cancel. Empty names revert to the previous value.

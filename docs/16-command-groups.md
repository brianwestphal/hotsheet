# 16. Custom Command Groups

Custom command buttons in the sidebar can be organized into collapsible groups with header titles, providing visual structure when many commands are configured.

## 16.1 Data Model

The `CustomCommand` interface gains an optional `group` field:

```typescript
interface CustomCommand {
  name: string;
  prompt: string;
  icon?: string;
  color?: string;
  target?: 'claude' | 'shell';
  autoShowLog?: boolean;
  group?: string;  // group name; ungrouped if omitted
}
```

Commands with the same `group` value are rendered together under a shared collapsible header. Commands without a `group` value (or with an empty string) remain ungrouped and appear at the top level, before any groups.

The ordering within a group follows the same array order as the `custom_commands` settings value — the first command in a group determines the group's position in the sidebar relative to other groups and ungrouped commands.

### Expansion State

Group expansion state is stored as a JSON object in the `command_groups_collapsed` settings key:

```typescript
// { [groupName: string]: boolean }
// true = collapsed, absent or false = expanded
```

Groups default to expanded. Expansion state persists across page reloads and app restarts.

## 16.2 Sidebar Rendering

### Ungrouped Commands

Commands without a `group` value render exactly as they do today: individual buttons in the `#channel-commands-container`.

### Grouped Commands

For each unique group name (in order of first occurrence in the array):

1. A **group header** row is rendered. It contains:
   - A disclosure triangle (Lucide `chevron-right` icon, rotated 90 degrees when expanded)
   - The group name as plain text
2. Below the header, a **group body** container holds the group's command buttons, rendered identically to ungrouped commands.
3. When the group is **collapsed**, the body container is hidden (`display: none`). Only the header row is visible.
4. Clicking anywhere on the header row toggles the collapsed/expanded state and persists the change to settings.

### Styling

The group header uses the same horizontal space as command buttons. The disclosure triangle is positioned at the left edge; the group name is next to it. The header has a subtle hover effect (same opacity transition as `.channel-command-btn`). Group body commands are indented slightly (8px left padding) relative to ungrouped commands to indicate hierarchy.

## 16.3 Settings UI

### Group Assignment

Each command row in Settings > Experimental > Custom Commands gains a **Group** input field:

- A text input with placeholder "No group" positioned in the command row header, between the name field and the delete button.
- Typing a group name assigns the command to that group. Clearing the field removes the command from any group.
- An autocomplete dropdown shows existing group names (deduped from current commands) as the user types, filtered by the input value. Selecting from the dropdown fills the field.
- Changes auto-save like other command fields.

### Drag and Drop

Drag-and-drop reordering continues to work across the flat list. Moving a command between positions may change which group it visually appears in (since groups are determined by contiguous same-`group` commands), which is reflected immediately after the drop.

### No Separate Group Management

Groups are created implicitly by typing a name in any command's group field, and disappear when no commands reference them. There is no separate UI for creating, renaming, or deleting groups. To rename a group, the user edits the group field on each command in that group.

## 16.4 API

No new API endpoints. Group data is part of the existing `custom_commands` JSON setting. Expansion state uses the standard `PATCH /settings` endpoint with the `command_groups_collapsed` key.

## 16.5 Constraints

- Group names are case-sensitive. "Deploy" and "deploy" are distinct groups.
- Empty group names (empty string or whitespace-only) are treated as ungrouped.
- A group with all commands hidden (e.g., all Claude-targeted commands when the channel is disabled) is not rendered at all — neither the header nor the body.

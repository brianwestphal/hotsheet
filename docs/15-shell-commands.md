# 15. Shell Commands

Shell command targets allow custom command buttons to execute shell commands directly on the host machine, in addition to the existing Claude Code integration.

## 15.1 Custom Command Targets

Each custom command (configured in Settings > Experimental > Custom Commands) has a **target** field:

- **Claude Code** — sends the prompt to the Claude Channel (see [12-claude-channel.md](12-claude-channel.md)). Requires Claude Channel to be enabled.
- **Shell** — executes the prompt text as a shell command on the server. Works without Claude Channel.

When Claude Channel is disabled, new commands default to Shell target. If a command is set to Claude Code while the channel is disabled, a warning is shown indicating the command won't appear in the sidebar until the channel is enabled.

### Sidebar Visibility

Shell commands always appear in the sidebar, regardless of Claude Channel status. Claude Code commands only appear when the channel is enabled. The custom commands settings section is always visible in the Experimental tab (even without Claude CLI installed).

The target is selected via a dropdown in the command editor row, positioned before the prompt/command text field. When "Shell" is selected, the prompt label changes to "Shell command to run:" and the placeholder updates accordingly.

## 15.2 Shell Execution

When a shell-targeted command button is clicked:

1. The client POSTs to `/api/shell/exec` with the command string
2. The server spawns the command via `child_process.spawn()` with `shell: true`
3. The working directory is the project root (parent of the `.hotsheet/` data directory)
4. A `shell_command` entry is logged to the command log
5. The client shows a busy indicator ("Shell running") using the same status indicator as Claude Channel
6. stdout and stderr are captured; when the process exits, the existing `shell_command` log entry is updated in-place with the output appended (using a `---SHELL_OUTPUT---` separator in the detail field)
7. The client polls `/api/shell/running` to detect when the process finishes, then clears the busy state

## 15.3 Stopping a Running Process

Running shell processes can be stopped:

- In the **Commands Log** panel, entries with `event_type='shell_command'` show a stop button (square icon) if the process is still running
- Clicking the stop button calls `POST /api/shell/kill` with the log entry ID
- The server sends SIGTERM to the process, followed by SIGKILL after 3 seconds if it hasn't exited

## 15.4 API Endpoints

### POST /api/shell/exec

Execute a shell command asynchronously.

- **Body**: `{ command: string, name?: string }` — `name` is used as the log entry summary/label
- **Response**: `{ id: number }` — the command_log entry ID for tracking
- **Behavior**: Spawns the command, logs it, returns immediately. Process runs in background.

### POST /api/shell/kill

Kill a running shell process.

- **Body**: `{ id: number }` — the command_log entry ID
- **Response**: `{ ok: true }` or `{ error: string }` (404 if process not found)

### GET /api/shell/running

List currently running shell process IDs.

- **Response**: `{ ids: number[] }` — array of command_log entry IDs with active processes

## 15.5 Data Model

The `CustomCommand` interface includes an optional `target` field:

```typescript
interface CustomCommand {
  name: string;
  prompt: string;
  icon?: string;
  color?: string;
  target?: 'claude' | 'shell';  // default 'claude'
  autoShowLog?: boolean;        // controls whether Commands Log auto-opens on shell command completion
  group?: string;               // group header name (see [16-command-groups.md](16-command-groups.md))
}
```

Custom commands are stored in the `settings` table as a JSON string under the `custom_commands` key. The `target` field is omitted when set to `'claude'` (the default) to maintain backward compatibility with existing saved commands.

## 15.6 Command Log Integration

Shell commands use a single `shell_command` log entry that is updated in-place upon completion:

- **Initial entry**: Created when the command starts, with `event_type: 'shell_command'`, `direction: 'outgoing'`, and the command text as the detail.
- **On completion**: The same entry is updated — the summary is updated with the exit status (e.g., "exited with code 0"), and the detail field is updated with the stdout/stderr output appended after a `---SHELL_OUTPUT---` separator.

These appear in the Commands Log panel alongside Claude Channel events, with the "shell" badge label.

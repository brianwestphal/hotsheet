# 12. Claude Channel Integration

## 12.1 Overview

Hot Sheet can push events to a running Claude Code session via the Claude Channels protocol (MCP-based). This enables two workflows:

- **On-demand**: User clicks the play button to tell Claude to process the Up Next worklist.
- **Automatic**: When tickets are added to Up Next, Claude is automatically notified (with a 5-second debounce) to pick up the new work.

The feature is disabled by default and must be enabled in Settings. It is listed under an "Experimental" heading.

## 12.2 Architecture

The integration has three components:

1. **Channel server** — A small MCP server script bundled with Hot Sheet (`dist/channel.js` in production, `src/channel.ts` in dev). Registered in `.mcp.json` when the feature is enabled. Claude Code spawns it as a subprocess. It listens on a local HTTP port for commands from Hot Sheet.

2. **Hot Sheet server** — Detects when the channel is active by checking the channel port file. POSTs to the channel server's HTTP endpoint to push events to Claude. Provides `/api/channel/done` endpoint for Claude to signal completion.

3. **Hot Sheet UI** — Shows a play button in the sidebar when the channel is enabled. Single-click for on-demand, double-click for automatic mode.

```
Hot Sheet UI  →  Hot Sheet Server  →  Channel Server (HTTP)  →  Claude Code (stdio/MCP)
     ↑                                                                    |
     └──────────── Claude uses Hot Sheet API + /channel/done ←────────────┘
```

## 12.3 Channel Server

The channel server (`src/channel.ts`) is an MCP server that:

- Declares the `claude/channel` capability
- Connects to Claude Code over stdio (spawned as subprocess)
- Listens on a local HTTP port for commands from Hot Sheet
- Writes its port to `.hotsheet/channel-port` for Hot Sheet to discover
- Forwards HTTP POST content as `notifications/claude/channel` events
- Provides a `/health` endpoint for liveness checks

Instructions tell Claude: when a hotsheet channel event arrives, run `/hotsheet` to process the worklist, and signal completion when done.

## 12.4 Settings

The Claude Channel and custom commands are configured in the **Experimental** settings tab (Lucide Flask icon). This tab is always visible in Settings.

- **Claude Channel**: Enable/disable toggle. Disabled by default.
- The toggle is always visible, but disabled when the `claude` CLI is not detected on the system (`GET /api/channel/claude-check`).
- If Claude Code is installed but below v2.1.80, the toggle is disabled with a message to upgrade.
- When enabled: registers the channel server in `.mcp.json` (merging with existing entries) and shows launch instructions with a copyable command.
- When disabled: removes the channel entry from `.mcp.json`.
- Stored as `channelEnabled` boolean in the global config at `~/.hotsheet/config.json`. Legacy per-project `channel_enabled` setting in the database is used as a fallback if the global config has no value.

## 12.5 `.mcp.json` Registration

When the channel is enabled, Hot Sheet adds an entry to `.mcp.json`:

**Production** (installed via npm):
```json
{
  "mcpServers": {
    "hotsheet-channel": {
      "command": "node",
      "args": ["<path-to-dist>/channel.js", "--data-dir", "<data-dir>"]
    }
  }
}
```

**Dev mode** (running via tsx):
```json
{
  "mcpServers": {
    "hotsheet-channel": {
      "command": "npx",
      "args": ["tsx", "<path-to-src>/channel.ts", "--data-dir", "<data-dir>"]
    }
  }
}
```

The path detection uses `dirname(fileURLToPath(import.meta.url))` and checks for `dist/channel.js` first (production), then `src/channel.ts` (dev mode).

Existing `.mcp.json` entries are preserved (merge, not overwrite).

## 12.6 Port Coordination

The channel server writes its listening port to `.hotsheet/channel-port`. Hot Sheet reads this file to know where to send commands. The file is written on channel server startup and cleaned up on exit.

## 12.7 UI — Play Button

A green play button (Lucide "play" icon) appears in the sidebar above the custom commands area and the "Copy AI prompt" button when the channel is enabled.

### States

| State | Appearance | Trigger |
|-------|-----------|---------|
| Idle | Green play icon | — |
| On-demand fired | Brief pulse animation | Single click |
| Automatic mode | Lucide fast-forward icon (replaces play icon) | Double click to enable |
| Automatic off | Returns to play icon | Single click while in auto mode |

### Behavior

- **Single click**: Checks for Up Next items first. If none, shows a yellow warning alert "No Up Next items to process" (auto-dismisses after 4 seconds). If items exist, sends a one-time event to Claude. Button pulses briefly.
- **Double click**: Toggles automatic mode. The play icon swaps to a fast-forward icon.
- **Single click while in auto mode**: Turns off automatic mode, restores play icon.

## 12.8 Automatic Mode

When automatic mode is active:

1. **Immediate trigger** — When entering automatic mode (double-click), Claude is triggered immediately to process the current Up Next items.
2. **Up Next watching** — Hot Sheet then monitors for subsequent `up_next` changes on tickets. Each change restarts the debounce.
3. **Trigger after debounce** — After the debounce expires, Hot Sheet checks for Up Next items and whether Claude is idle:
   - If Claude is idle and Up Next items exist, a channel event is sent immediately.
   - If Claude is busy, Hot Sheet retries with the current backoff delay until Claude becomes idle, then triggers.
4. **Exponential backoff** — After each trigger, Hot Sheet verifies Claude became busy within 10 seconds. If not (e.g. Claude is in a weird state), the backoff counter increments. The retry delay doubles with each consecutive failed attempt: 5s → 10s → 20s → 40s → 80s → 120s (max 2 minutes). When Claude successfully picks up work (becomes busy), the backoff resets to 0.
5. **Re-trigger on completion** — When Claude signals done (`/channel/done`), if automatic mode is still active, a new debounce starts to check for remaining or newly added Up Next items.
6. The event content tells Claude to run `/hotsheet` to process the current Up Next items.

## 12.9 Channel Communication

### Hot Sheet → Claude (via channel)

Events are sent as MCP `notifications/claude/channel` messages with `{ content, meta: { type: 'worklist' } }` params. Claude Code renders these to the user as XML-wrapped channel events:

```
<channel source="hotsheet-channel" type="worklist">
Process the Hot Sheet worklist. Run /hotsheet to work through the current Up Next items.

When you are completely finished processing all items (or if the worklist was empty), signal completion by running:
curl -s -X POST http://localhost:<port>/api/channel/done
</channel>
```

### Claude → Hot Sheet (via API)

Claude communicates back using:

1. **Existing Hot Sheet REST API** — updating ticket status, adding notes, etc. as described in the worklist.md file and AI tool skills.
2. **Completion signal** — `POST /api/channel/done` when finished processing (or when the worklist was empty). This clears the "Claude working" indicator in the UI.

### Busy/Idle Status

- When a trigger is sent, the status bar shows "Claude working" with a spinning loader icon.
- When Claude calls `/api/channel/done`, the status changes to "✓ Claude idle" (auto-hides after 5 seconds).
- The done flag is consumed on read (one-shot) and reset on each new trigger.
- A 120-second timeout fallback clears the busy state if Claude never signals completion.

## 12.10 Ping-Based Busy Detection

Hot Sheet can actively probe whether Claude is busy or idle by sending a lightweight "ping" through the channel. This is more reliable than inferring busy state from the done flag alone.

### How it works

1. Hot Sheet sends a channel event asking Claude to `curl` back to a `/api/channel/pong` endpoint with a unique nonce.
2. If Claude is idle, it processes the ping immediately and curls back — Hot Sheet receives the pong within seconds.
3. If Claude is busy (processing a task, waiting for permission, etc.), it cannot act on the ping until it finishes — the request times out.

The ping has a **15-second timeout**. The result is one of three states:

| Result | Meaning |
|--------|---------|
| `true` | Claude responded (idle) |
| `false` | Claude did not respond in time (busy) |
| `null` | No channel is active (channel not connected) |

### Settings

Ping-based busy detection is a per-project setting in **Settings → Experimental**: "Enable busy status detection (ping)". It is **unchecked by default**.

### Activity gate

Pings are only sent when the user has been active in Hot Sheet within the last **2 minutes**. This prevents unnecessary pings when the user has walked away.

### Multi-project pings

The `POST /api/projects/ping` endpoint pings all registered projects' Claude channels **in parallel**, returning results for each project. Each individual ping uses the same 15-second timeout.

### Usage in automatic mode

In automatic mode (§12.8), ping-based busy detection is used to verify Claude's busy state before entering backoff. When the ping setting is enabled, automatic mode pings Claude instead of relying solely on the done-flag heuristic. This prevents false backoff cycles when Claude has already finished but the done signal was missed.

### Manual check

Right-clicking the status bar shows a **"Check Claude Status"** context menu item. Clicking it triggers a manual ping and updates the busy/idle indicator with the result.

### Channel server endpoints

The channel server exposes two additional HTTP endpoints for ping support:

- **`/ping`** — Accepts a POST with a nonce. Sends a channel event asking Claude to curl back with the nonce. Returns immediately (the response comes asynchronously via pong).
- **`/shutdown`** — Gracefully shuts down the channel server.

## 12.11 Permission Relay

When Claude needs approval to run a tool (Bash, Write, Edit, etc.), the channel server receives a permission request notification and forwards it to Hot Sheet.

### How it works

1. The channel server declares `claude/channel/permission` capability
2. When Claude calls a tool that needs approval, Claude Code sends `notifications/claude/channel/permission_request` to the channel server
3. The channel server stores the pending request and exposes it via `GET /permission`
4. Hot Sheet long-polls `GET /api/channel/permission` — the server holds the connection up to 3 seconds, returning immediately when a permission arrives (the channel server notifies via `POST /api/channel/permission/notify`)
5. When a pending permission is detected, a full-screen overlay appears

### Overlay

A dark, blurred overlay with large white text: "Claude is waiting for permission". Below it shows the tool name, description, and the `input_preview` (the actual command or file path being requested) in a monospace code block. The overlay content area uses the full available screen width (minus padding) so command previews are easy to read. Three buttons:

- **Allow** — sends `behavior: 'allow'` back to Claude Code, tool proceeds
- **Deny** — sends `behavior: 'deny'`, tool is rejected
- **Dismiss** — closes the overlay without responding (the terminal dialog remains open for the user to handle there)

The pending permission expires on the server after 120 seconds if not acted on. The client overlay reflects this by closing when the server reports no pending permission.

Note: The local terminal dialog stays open in parallel. Whichever is answered first (Hot Sheet or terminal) takes effect.

## 12.12 Custom Commands

When the Claude Channel is enabled, users can create custom command buttons that appear below the play button in the sidebar.

### Configuration

In Settings → Experimental → Custom Commands:
- Click "Add Command" to create a new command
- Each command has:
  - **Color** — chosen from a dropdown palette of 9 colors (Neutral, Blue, Green, Orange, Red, Purple, Pink, Teal, Gray). Defaults to Neutral (#e5e7eb). Text/icon color auto-computed for contrast.
  - **Icon** — chosen from a picker with all 1693 Lucide icons. 24 featured action icons shown at top, with search to find any icon by name.
  - **Name** — button label text
  - **Prompt** — text sent to Claude when clicked
- Commands can be reordered by dragging the hamburger handle
- Commands are stored as JSON in the `custom_commands` settings key

### UI

- Custom command buttons appear in the sidebar below the play button
- Each button shows icon + left-aligned name on a colored background
- Clicking a button sends the configured prompt to Claude via the channel
- The completion signal (`/channel/done`) is automatically appended to all prompts

### Example

Name: `Commit Changes`
Prompt: `Make a commit message for the recently completed tickets, without wrapping long lines. Add all unstaged changes to the git commit. Git commit with the message you generated but don't push.`

## 12.13 API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/channel/claude-check` | GET | Check if `claude` CLI is installed and meets minimum version (v2.1.80+) |
| `/api/channel/status` | GET | Returns `{ enabled, alive, port, done }` — channel state and completion flag |
| `/api/channel/trigger` | POST | Send a worklist event to Claude via the channel server |
| `/api/channel/done` | POST | Called by Claude to signal it has finished processing |
| `/api/channel/enable` | POST | Enable the channel and register in `.mcp.json` |
| `/api/channel/disable` | POST | Disable the channel and remove from `.mcp.json` |
| `/api/channel/permission` | GET | Check for pending permission requests from Claude |
| `/api/channel/permission/respond` | POST | Respond to a permission request (`{ request_id, behavior }`) |
| `/api/channel/permission/dismiss` | POST | Dismiss a pending permission overlay without responding |
| `/api/channel/notify` | POST | Notify long-poll of channel state changes (used internally by channel server) |
| `/api/channel/permission/notify` | POST | Wake the permission long-poll when a new permission request arrives (used internally by channel server) |
| `/api/channel/ping` | POST | Ping active project's Claude to check busy/idle (15s timeout) |
| `/api/channel/pong` | POST | Pong callback from Claude (nonce-authenticated) |

## 12.14 Requirements

- Claude Code v2.1.80+ with claude.ai login
- During research preview: `--dangerously-load-development-channels server:hotsheet-channel` flag
- `@modelcontextprotocol/sdk` npm package (dependency of the channel server)

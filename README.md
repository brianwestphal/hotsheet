<div align="center">

# Hot Sheet

### A fast, local ticket tracker that feeds your AI coding tools.

<br>

**Hot Sheet** is a lightweight project management tool that runs entirely on your machine. Create tickets with a bullet-list interface, drag them into priority order, and your AI tools automatically get a structured worklist they can act on.

No cloud. No logins. No JIRA. Just tickets and a tight feedback loop.

<br>

**Desktop app** (recommended) — download from [GitHub Releases](https://github.com/brianwestphal/hotsheet/releases):

| Platform | Download |
|----------|----------|
| macOS (Apple Silicon) | `.dmg` (arm64) |
| macOS (Intel) | `.dmg` (x64) |
| Linux | `.AppImage` / `.deb` |
| Windows | `.msi` / `.exe` |

After installing, open the app and click **Install CLI** to add the `hotsheet` command to your PATH.

**Or install via npm:**

```bash
npm install -g hotsheet
```

Then, from any project directory:

```bash
hotsheet
```

That's it. Data stays local.

> **Note:** We're actively developing and testing on macOS. Linux and Windows builds are provided but less tested — if you run into issues on those platforms, we'd love your help! Please [open an issue](https://github.com/brianwestphal/hotsheet/issues).

</div>

<br>

<p align="center">
  <img src="docs/demo-1.png" alt="Hot Sheet main UI showing tickets across categories, priorities, and statuses with the detail panel open" width="900">
</p>

---

## Why Hot Sheet?

AI coding tools are powerful, but they need direction. You know what needs to be built, fixed, or investigated — but communicating that to your AI tool means typing the same context over and over, or maintaining a text file that drifts out of sync.

Hot Sheet gives you a proper ticket interface — categories, priorities, statuses — with one key difference: it automatically exports a `worklist.md` file that AI tools like Claude Code can read directly. Your tickets become the AI's task list.

The workflow:

1. **You** create and prioritize tickets in Hot Sheet
2. **Hot Sheet** syncs an `Up Next` worklist to `.hotsheet/worklist.md`
3. **Your AI tool** reads the worklist and works through it
4. **You** mark tickets complete and add new ones

The loop stays tight because the AI always knows what to work on next.

---

## Features

**Bullet-list input** — type a title, hit Enter, ticket created. Set category and priority inline with keyboard shortcuts.

<p align="center">
  <img src="docs/demo-2.png" alt="Quick ticket entry with the bullet-list input row" width="900">
</p>

**Customizable categories** — defaults to a software development set (Issue, Bug, Feature, Req Change, Task, Investigation), with built-in presets for Design, Product Management, Marketing, and Personal workflows. Each category has a color, badge label, and keyboard shortcut — all configurable in Settings.

<p align="center">
  <img src="docs/demo-3.png" alt="Sidebar with custom views and category filtering" width="900">
</p>

**Column view** — switch to a kanban-style board grouped by status. Drag tickets between columns to change status, or drag onto sidebar items to set category, priority, or view.

<p align="center">
  <img src="docs/demo-7.png" alt="Column view showing tickets organized by status in a kanban board" width="900">
</p>

**Batch operations** — select multiple tickets to bulk-update category, priority, status, or Up Next. The overflow menu (⋯) provides duplicate, tags, move to backlog, and archive actions. Right-click any ticket for a full context menu with submenus.

<p align="center">
  <img src="docs/demo-5.png" alt="Multiple tickets selected with the batch toolbar and context menu" width="900">
</p>

**Detail panel** — side or bottom orientation (toggle in the toolbar), resizable. Shows category, priority, status, and Up Next in a compact grid, plus title, details, tags, attachments, and editable notes. Click a note to edit inline; right-click to delete.

<p align="center">
  <img src="docs/demo-6.png" alt="Detail panel in bottom orientation showing ticket details, tags, and notes" width="900">
</p>

**Stats dashboard** — click the sidebar widget to open a full analytics page with throughput charts, created-vs-completed trends, cumulative flow diagram, category breakdown, and cycle time scatter plot. Hover any chart for detailed tooltips.

<p align="center">
  <img src="docs/demo-8.png" alt="Stats dashboard showing throughput, flow, and cycle time charts" width="900">
</p>

**Also includes:**
- **Tags** — free-form tags on tickets, with autocomplete and a batch tag dialog for multi-select
- **Custom views** — create filtered views with an interactive query builder (field + operator + value conditions, AND/OR logic)
- **Five priority levels** — Highest to Lowest, sortable and filterable
- **Up Next flag** — star tickets to add them to the AI worklist
- **Drag and drop** — drag tickets onto sidebar views to change category, priority, or status; reorder custom views
- **Right-click context menus** — full context menu on tickets with category/priority/status submenus, tags, duplicate, delete
- **Search** — full-text search across ticket titles, details, and ticket numbers
- **Print** — print the dashboard, all tickets, selected tickets, or individual tickets in checklist, summary, or full-detail format
- **Keyboard-driven** — `Enter` to create, `Cmd+I/B/F/R/K/G` for categories, `Alt+1-5` for priority, `Cmd+D` for Up Next, `Delete` to trash, `Cmd+P` to print, `Cmd+Z/Shift+Z` for undo/redo
- **Undo/redo** — `Cmd+Z` and `Cmd+Shift+Z` for all operations including notes, batch changes, and deletions
- **Animated transitions** — smooth FLIP animations when tickets reorder after property changes
- **Copy for commits** — `Cmd+C` copies selected ticket info (number + title + details + notes) for use in commit messages
- **File attachments** — attach files to any ticket, reveal in file manager
- **Markdown sync** — `worklist.md` and `open-tickets.md` auto-generated on every change
- **Automatic backups** — tiered snapshots (every 5 min, hourly, daily) with preview-before-restore recovery
- **Auto-cleanup** — configurable auto-deletion of old trash and verified items
- **Fully local** — embedded PostgreSQL (PGLite), no network calls, no accounts, no telemetry

---

## AI Integration

The exported worklist is plain markdown. Any AI tool that can read files can use it.

Star tickets as "Up Next" and they appear in the worklist, sorted by priority. As the AI works, it updates ticket status and appends notes — visible right in the detail panel.

<p align="center">
  <img src="docs/demo-4.png" alt="Up Next view showing prioritized tickets with AI progress notes in the detail panel" width="900">
</p>

### Claude Code

Point Claude Code at your worklist:

```
Read .hotsheet/worklist.md and work through the tickets in order.
```

Or add it to your `CLAUDE.md`:

```markdown
Read .hotsheet/worklist.md for current work items.
```

Hot Sheet automatically generates skill files for Claude Code (as well as Cursor, GitHub Copilot, and Windsurf) so your AI tool can create tickets directly. Run `/hotsheet` in Claude Code to process the worklist.

### Claude Channel Integration (Experimental)

Hot Sheet can push events directly to a running Claude Code session via MCP channels. Enable it in Settings → Experimental (the tab only appears when Claude Code is detected on your system):

- **Play button** — appears in the sidebar. Single-click sends the worklist to Claude on demand.
- **Auto mode** — double-click the play button to enable automatic mode. When you star a ticket for Up Next, Claude is notified after a 5-second debounce and picks up the work automatically.
- **Custom commands** — create named buttons that send custom prompts to Claude. For example, a "Commit Changes" button that tells Claude to generate a commit message from recently completed tickets and commit. Configure in Settings → Experimental → Custom Commands.
- **Status indicator** — shows "Claude working" / "Claude idle" in the footer.

Requires Claude Code v2.1.80+ with channel support. See [docs/12-claude-channel.md](docs/12-claude-channel.md) for setup details.

<p align="center">
  <img src="docs/demo-9.png" alt="Claude Channel integration with play button, custom command buttons, and AI-driven workflow" width="900">
</p>

### Other AI Tools

The worklist works with any AI tool that reads files — Cursor, Copilot, Aider, etc. Each ticket includes its number, type, priority, status, title, and details.

### What gets exported

`worklist.md` contains all tickets flagged as "Up Next," sorted by priority:

```
# Hot Sheet - Up Next

These are the current priority work items. Complete them in order of priority, where reasonable.

---

TICKET HS-12:
- Type: bug
- Priority: highest
- Status: not started
- Title: Fix login redirect loop
- Details: After session timeout, the redirect goes to /login?next=/login...

---

TICKET HS-15:
- Type: feature
- Priority: high
- Status: started
- Title: Add CSV export for reports
```

---

## Backups & Data Safety

Hot Sheet automatically protects your data with tiered backups and instance locking.

### Automatic backups

Backups run on three schedules, each keeping a rolling window of snapshots:

| Tier | Frequency | Retention |
|------|-----------|-----------|
| Recent | Every 5 minutes | Last hour (up to 12) |
| Hourly | Every hour | Last 12 hours (up to 12) |
| Daily | Every day | Last 7 days (up to 7) |

You can also trigger a manual backup at any time from the settings panel with the **Backup Now** button.

### Recovering from a backup

Open the settings panel (gear icon) to see all available recovery points grouped by tier. Click any backup to enter **preview mode** — the app switches to a read-only view of the backup's data. You can navigate views, filter by category/priority, switch to column layout, and inspect individual tickets to verify it's the right recovery point.

If it looks correct, click **Restore This Backup** to replace the current database. A safety snapshot of your current data is automatically created before the restore, so you can always go back.

### Configurable backup location

By default, backups are stored in `.hotsheet/backups/`. To store them elsewhere — for example, a folder synced by iCloud, Google Drive, or Dropbox — set the `backupDir` in `.hotsheet/settings.json`:

```json
{
  "backupDir": "/Users/you/Library/Mobile Documents/com~apple~CloudDocs/hotsheet-backups"
}
```

This can also be changed from the settings panel UI.

### Instance locking

Only one Hot Sheet instance can use a data directory at a time. If you accidentally start a second instance pointing at the same `.hotsheet/` folder, it will exit with a clear error instead of risking database corruption. The lock is automatically cleaned up when the app stops.

---

## Install

### Desktop app (recommended)

Download the latest release for your platform from [GitHub Releases](https://github.com/brianwestphal/hotsheet/releases).

On first launch, the app will prompt you to install the `hotsheet` CLI command. This creates a symlink so you can launch the desktop app from any project directory. You can also install it manually:

**macOS:**
```bash
sudo sh -c 'mkdir -p /usr/local/bin && ln -sf "/Applications/Hot Sheet.app/Contents/Resources/resources/hotsheet" /usr/local/bin/hotsheet'
```

**Linux:**
```bash
ln -sf /path/to/hotsheet/resources/hotsheet-linux ~/.local/bin/hotsheet
```

The desktop app includes automatic updates — new versions are downloaded and applied in the background.

### npm

Alternatively, install via npm (runs in your browser instead of a native window):

```bash
npm install -g hotsheet
```

Requires **Node.js 20+**.

---

## Usage

```bash
# Start from your project directory
hotsheet

# Custom port (npm version only)
hotsheet --port 8080

# Custom data directory
hotsheet --data-dir ~/projects/my-app/.hotsheet

# Force browser mode (desktop app)
hotsheet --browser
```

### Options

| Flag | Description |
|------|-------------|
| `--port <number>` | Port to run on (default: 4174) |
| `--data-dir <path>` | Data directory (default: `.hotsheet/`) |
| `--browser` | Open in browser instead of desktop window |
| `--help` | Show help |

### Settings file

Create `.hotsheet/settings.json` to configure per-project options:

```json
{
  "appName": "HS - My Project",
  "backupDir": "/path/to/backup/location"
}
```

| Key | Description |
|-----|-------------|
| `appName` | Custom window title (defaults to the project folder name) |
| `backupDir` | Backup storage path (defaults to `.hotsheet/backups/`) |

Both settings can also be changed from the settings panel UI.

### Keyboard shortcuts

| Shortcut | Action |
|----------|--------|
| `Enter` | Create new ticket |
| `Cmd+I/B/F/R/K/G` | Set category (customizable) |
| `Alt+1-5` | Set priority (Highest to Lowest) |
| `Cmd+D` | Toggle Up Next |
| `Delete` / `Backspace` | Delete selected tickets |
| `Cmd+C` | Copy ticket info |
| `Cmd+A` | Select all |
| `Cmd+Z` | Undo |
| `Cmd+Shift+Z` | Redo |
| `Cmd+P` | Print |
| `Cmd+F` | Focus search |
| `Cmd+N` / `N` | Focus new ticket input |
| `Escape` | Blur field / clear selection / close |

---

## Architecture

| Layer | Technology |
|-------|-----------|
| Desktop | Tauri v2 (native window, auto-updates) |
| CLI | TypeScript, Node.js |
| Server | Hono |
| Database | PGLite (embedded PostgreSQL) |
| UI | Custom server-side JSX (no React), vanilla client JS |
| Charts | Inline SVG (no external chart library) |
| Build | tsup (single-file bundle) |
| Storage | `.hotsheet/` in your project directory |

Data stays local. No network calls, no accounts, no telemetry.

---

## Development

```bash
git clone <repo-url>
cd hotsheet
npm install

npm run dev              # Build client assets, then run via tsx
npm run build            # Build to dist/cli.js
npm run clean            # Remove dist and caches
npm link                 # Symlink for global 'hotsheet' command
```

---

## See Also

- **[Glassbox](https://github.com/brianwestphal/glassbox)** — AI-powered code review tool. Runs locally, reviews your changes, and posts inline annotations. Pairs well with Hot Sheet for a complete local dev workflow.

---

## License

MIT

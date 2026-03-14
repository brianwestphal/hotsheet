# 6. Markdown Sync & AI Integration

## Functional Requirements

### 6.1 Worklist Export

- Tickets flagged as Up Next are exported to `.hotsheet/worklist.md`, sorted by priority.
- The file includes:
  - Workflow instructions with curl examples for updating ticket status via the API.
  - Per-ticket details: ID, type, priority, status, title, details, notes (with timestamps), and attachment list.
  - A category descriptions reference.
  - Guidance that status updates and completion notes are required.
- Updated on a 500ms debounce after any ticket change.

### 6.2 Open Tickets Export

- All open tickets (not_started and started) are exported to `.hotsheet/open-tickets.md`, grouped by status.
- Includes ticket count and the same per-ticket format as the worklist.
- Updated on a 5-second debounce after any ticket change.

### 6.3 Sync Triggers

Both markdown files are regenerated on:
- Ticket creation, update, or deletion
- Status changes
- Category or priority changes
- Notes appended
- Attachments added or removed
- Batch operations

### 6.4 Copy AI Prompt

- The sidebar includes a "Copy AI prompt" button that copies a short prompt (e.g., "Read .hotsheet/worklist.md for current work items.") to the clipboard.
- Intended for pasting into AI tools that don't support skills/rules natively.

### 6.5 AI Tool Skill Generation

On startup, the application detects installed AI tools and generates skill/rule files that allow those tools to interact with Hot Sheet. Files are only regenerated when the skill version changes.

#### Claude Code (`.claude/`)
- Creates skill files in `.claude/skills/`: a main `hotsheet` skill (read worklist and work through items) and per-category ticket creation skills (hs-bug, hs-feature, hs-task, hs-issue, hs-investigation, hs-req-change).
- Configures permissions in `.claude/settings.json` with curl access patterns covering ports 4170-4189.
- Each skill has YAML frontmatter (name, description, allowed-tools).

#### Cursor (`.cursor/`)
- Creates rule files in `.cursor/rules/`: `hotsheet.mdc` (main) and per-category `.mdc` files.
- Uses Cursor's `.mdc` format with YAML frontmatter (description, alwaysApply: false).

#### GitHub Copilot (`.github/`)
- Creates prompt files in `.github/prompts/`: `hotsheet.prompt.md` (main) and per-category `.prompt.md` files.
- Only generated if `.github/prompts/` or `.github/copilot-instructions.md` already exists.
- Uses YAML frontmatter (description).

#### Windsurf (`.windsurf/`)
- Creates rule files in `.windsurf/rules/`: `hotsheet.md` (main) and per-category `.md` files.
- Uses YAML frontmatter (trigger: manual, description).

#### Ticket Creation Skills
- All per-category skills parse user input for "next", "up next", or "do next" prefix to set `up_next: true`.
- Create tickets via curl POST to the local API.
- Report the created ticket number and title.

### 6.6 Skills Notification

- When skill files are created or updated, a one-time banner is shown in the UI advising the user to restart their AI tool.
- The banner is dismissable and only shown once per server session.

### 6.7 Version Tracking

- Generated skill files include a version comment (e.g., `<!-- hotsheet-skill-version: 2 -->`).
- Files are only regenerated when the embedded skill version is higher than the existing file's version.

## Non-Functional Requirements

### 6.8 Debouncing

- Markdown sync is debounced to avoid excessive file writes during rapid changes (500ms for worklist, 5s for open-tickets).

### 6.9 Portability

- Skill files use a port range pattern (4170-4189) rather than a specific port, so they remain valid across port changes.

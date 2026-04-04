# 2. Data Storage

## Functional Requirements

### 2.1 Embedded Database

- The application uses an embedded PostgreSQL database (PGLite) requiring no external database server.
- All data is stored locally in a `.hotsheet/` directory within the project root (or a custom path via `--data-dir`).
- Database schema is managed through inline SQL migrations that run automatically on startup.

### 2.2 Database Tables

#### Tickets Table
- Stores ticket records with fields: id, ticket_number, title, details, category, priority, status, up_next, notes, created_at, updated_at, completed_at, verified_at, deleted_at.
- Ticket numbers are auto-generated from a PostgreSQL sequence (`ticket_seq`) and prefixed with `HS-` (e.g., HS-1, HS-42). Numbers are never reused.
- Notes are stored as a JSON-encoded text array of `{ text, created_at }` entries, with legacy plain-text support.

#### Attachments Table
- Stores file attachment metadata: id, ticket_id, original_filename, stored_path, created_at.
- Linked to tickets via foreign key.

#### Settings Table
- Key-value store for application configuration (detail_position, detail_width, detail_height, trash_cleanup_days, verified_cleanup_days, layout).

### 2.3 File-Based Settings

- A separate `settings.json` file in the data directory stores settings that need to be readable without a database connection: `appName` and `backupDir`.

### 2.4 Lock File

- A `hotsheet.lock` file prevents multiple instances from using the same database simultaneously.
- Contains JSON with `pid` and `startedAt`.
- On startup, checks if the lock holder PID is still alive (signal 0). Stale locks from dead processes are automatically removed.
- If the lock file belongs to the current process (same PID), `acquireLock()` returns immediately instead of terminating. This allows a project to be re-registered after being removed from a tab without the server killing itself.
- Lock is cleaned up on process exit.

### 2.5 Instance File

- An `instance.json` file is written to `~/.hotsheet/` on server startup and removed on exit.
- Contains `port` and `pid` of the running server.
- Used by the CLI for `--list` and `--close` commands, and for detecting whether a running instance can be joined instead of starting a new one.

### 2.6 Projects Registry

- A `projects.json` file in `~/.hotsheet/` persists the list of registered project `dataDir` paths across server restarts.
- On startup, previously registered projects whose directories still exist are automatically re-registered.
- When a project is added or removed via the API, the file is updated immediately.

### 2.7 Gitignore Management

- On startup, detects if the project is a git repository.
- Automatically adds `.hotsheet/` to `.gitignore` if not already present.
- Provides API endpoints to check status and trigger gitignore addition from the UI.

## Non-Functional Requirements

### 2.8 Data Locality

- All data remains on the local machine. There is no cloud sync, external API dependency, or remote storage.

### 2.9 Zero Configuration

- The database initializes automatically on first run with no manual setup, provisioning, or configuration required.

### 2.10 Data Integrity

- Only one application instance may access the database at a time, enforced by the lock file mechanism.
- Soft-delete is the default for ticket removal; hard delete is a separate, explicit operation.

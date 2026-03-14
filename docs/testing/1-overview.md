# Testing Strategy Overview

## Current State

The project has no automated tests. All testing has been manual before each release. This document outlines a strategy to build test coverage incrementally, prioritized by risk.

## Recommended Stack

- **Vitest** — Test runner (ESM-native, lightweight, Jest-compatible API)
- **PGLite** — Tests use the same embedded database as the app, creating temporary instances per test suite
- **happy-dom** — Lightweight DOM implementation for client-side unit tests (if needed)

## Test Organization

Tests live alongside source files using the `.test.ts` convention:

```
src/
  db/
    queries.test.ts          # Database query logic
    connection.test.ts       # Schema and migrations
  routes/
    api.test.ts              # API endpoint integration tests
  sync/
    markdown.test.ts         # Markdown generation
  backup.test.ts             # Backup and restore
  cleanup.test.ts            # Auto-cleanup logic
  skills.test.ts             # AI tool skill generation
  lock.test.ts               # Lock file management
  gitignore.test.ts          # Gitignore management
  client/
    state.test.ts            # State helpers and display functions
```

## Database Testing Approach

- Each test suite creates a temporary PGLite instance in an isolated temp directory.
- Schema is initialized fresh for each suite.
- Tests within a suite share the database but should not depend on ordering.
- Temp directories are cleaned up after each suite.

## Priority Order

Tests should be built in this order, focusing on the highest-risk areas first:

1. **Database queries** — Status transitions, filtering, notes parsing, batch operations
2. **API endpoints** — CRUD, batch, attachments, settings
3. **Backup & restore** — Data integrity through the backup lifecycle
4. **Markdown sync** — Content generation, debouncing
5. **Skills generation** — Version parsing, file update logic, multi-platform detection
6. **Cleanup** — Threshold calculations, file deletion
7. **CLI & server** — Argument parsing, port selection, startup sequence
8. **Client logic** — State helpers, keyboard shortcuts (if DOM testing is practical)

## What These Docs Cover

Each document in this directory describes a test focus area at a strategic level — what needs coverage and why, not individual test cases. The intent is to guide test implementation and identify gaps.

| Document | Focus Area | Risk Level |
|----------|-----------|------------|
| [2-database.md](2-database.md) | Query logic, schema, status transitions | High |
| [3-api.md](3-api.md) | REST API endpoints, input handling | High |
| [4-backup-restore.md](4-backup-restore.md) | Backup lifecycle, restore safety | High |
| [5-markdown-sync.md](5-markdown-sync.md) | Worklist and open-tickets generation | Medium |
| [6-skills.md](6-skills.md) | AI tool skill file generation | Medium |
| [7-cleanup-and-lifecycle.md](7-cleanup-and-lifecycle.md) | Auto-cleanup, lock files, gitignore, CLI | Medium |
| [8-client.md](8-client.md) | Client-side state, interactions, rendering | Medium |

---
name: test-permission-write
description: Trigger a permission prompt for the Write tool by creating a brand new file in /tmp.
---

Trigger a Write-tool permission prompt for a new file.

**Use a fresh filename every invocation** so the skill is idempotent — if the file already exists, Write requires a prior Read and the prompt no longer reflects the "brand new file" path. Build the path as `/tmp/claude-permission-test/write-test-<unique>.txt` where `<unique>` is a Unix timestamp with nanoseconds or a short random hex string you generate yourself for this call (do not reuse a value from a previous run).

Call Write with:

- `file_path`: `/tmp/claude-permission-test/write-test-<unique>.txt` (substitute your fresh `<unique>` value)
- `content`:
  ```
  This file was created by the test-permission-write skill.
  Its sole purpose is to surface the Write-tool permission prompt.
  Safe to delete.
  ```

If the parent directory doesn't exist yet, create it first via Bash:

```bash
mkdir -p /tmp/claude-permission-test
```

(That Bash call will surface a separate Bash prompt — that's fine.)

Do NOT Read the file first — the file should not exist yet, and reading it would defeat the "brand new file" prompt path this skill is testing.

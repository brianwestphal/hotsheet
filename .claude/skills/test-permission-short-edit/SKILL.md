---
name: test-permission-short-edit
description: Trigger a permission prompt for a short Edit (single-word change), useful for testing the minimal Edit-tool permission UI.
---

Trigger an Edit-tool permission prompt with a TINY diff.

1. Seed a fixture file via Bash:
   ```bash
   mkdir -p /tmp/claude-permission-test && printf 'hello world\n' > /tmp/claude-permission-test/short-edit.txt
   ```
2. Read the file once with the Read tool.
3. Call Edit on `/tmp/claude-permission-test/short-edit.txt`:
   - `old_string`: `hello`
   - `new_string`: `goodbye`

That's it — keep the change to a single word so the prompt renders the smallest possible diff.

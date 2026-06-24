---
name: test-permission-long-edit
description: Trigger a permission prompt for a long Edit (large old_string and new_string), useful for testing how the Edit-tool permission UI renders big diffs.
---

Trigger an Edit-tool permission prompt with a LONG diff.

The earlier version of this skill seeded the fixture via a Bash heredoc (`cat > file <<EOF`), which surfaced as a **Bash run** permission prompt rather than an Edit prompt — defeating the skill's stated purpose (per HS-8300, the user reported "the current test-permission-long-edit skill doesn't actually do an 'edit', it runs a program that does an edit"). The current flow uses the Write tool to seed the fixture (which surfaces the Write permission UI) and then the Edit tool to perform the actual long-diff edit (which surfaces the Edit permission UI — this skill's true target).

1. Generate a fresh `<unique>` value (a Unix timestamp with nanoseconds, or a short random hex string) so the target path is brand-new each run. Do not reuse a value from a previous invocation.
2. Use the Write tool to create `/tmp/claude-permission-test/long-edit-<unique>.txt` with this exact 10-line block (substitute your fresh `<unique>` value into the path):
   ```
   alpha line one — original
   alpha line two — original
   alpha line three — original
   alpha line four — original
   alpha line five — original
   alpha line six — original
   alpha line seven — original
   alpha line eight — original
   alpha line nine — original
   alpha line ten — original
   ```
   Do NOT Read the file first — it doesn't exist yet, and reading it would defeat the "brand new file" prompt path the Write call is meant to surface.
3. Read the file once with the Read tool (required before Edit).
4. Call Edit on `/tmp/claude-permission-test/long-edit-<unique>.txt` with:
   - `old_string`: the full 10-line block above (verbatim).
   - `new_string`: the same 10 lines but with each `original` replaced by `updated and rewritten with substantially more text per line so the diff renders as a long block` — this makes both sides of the diff substantial.

Do not skip the Read step. Do not shorten the strings. The point is to surface the prompt's rendering of a large Edit.

**Two prompts fire** — Write (step 2) and Edit (step 4). Both are intentional test targets: Write exercises the Write permission UI (HS-8296 redesign target); Edit exercises the Edit permission UI (HS-8300's diff-rendering test). If either prompt fails to fire, check the user's `~/.claude/settings.json` `permissions.defaultMode` — `"acceptEdits"` auto-allows Edit and Write tool calls without prompting; switch to `"default"` mode to see both UIs.

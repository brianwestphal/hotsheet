---
name: test-permission-parallel
description: Trigger multiple permission prompts at once by issuing several tool calls in a single message — tests the batched/queued permission UI.
---

Trigger several permission prompts in a single message.

In ONE assistant message, issue these three tool calls in parallel (all together, no sequencing):

1. Bash: `command: "pwd"`, `description: "Parallel-test command 1"`.
2. Bash: `command: "whoami"`, `description: "Parallel-test command 2"`.
3. Bash: `command: "printf '%s\\n' parallel-test-3"`, `description: "Parallel-test command 3"`.

After they all return, just say "parallel test complete". The point is to see how the permission UI handles a batch of prompts arriving simultaneously.

**Why these commands?** Most users have `Bash(echo *)` and similar entries in their Claude Code allow-list (`~/.claude/settings.json`); when an allow-rule matches, Claude Code skips the permission prompt entirely so Hot Sheet never sees one to surface. `pwd` / `whoami` / `printf` are rarely allowlisted and reliably trigger three concurrent prompts. If a single command in the batch silently runs without prompting, check the user's `~/.claude/settings.json` for a matching rule before suspecting a Hot Sheet regression.

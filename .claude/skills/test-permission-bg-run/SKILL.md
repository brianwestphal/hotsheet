---
name: test-permission-bg-run
description: Trigger a permission prompt for a background Bash command (run_in_background=true).
---

Trigger a Bash permission prompt for a BACKGROUND command.

Call Bash with:

- `command`: `sleep 30 && pwd`
- `description`: `Background-run permission test (sleeps 30s)`
- `run_in_background`: `true`

After the call returns, just relay the background task ID to the user. Do NOT poll, sleep, or check on it — the point is the prompt, not the result.

**Why `sleep 30 && pwd` and not `sleep 30 && echo "bg test done"`?** Most users have `Bash(echo *)` in their Claude Code allow-list (`~/.claude/settings.json`). Claude Code's allow-list matcher can short-circuit chained `&&` commands when every link matches an allow-rule, suppressing the prompt. `pwd` is rarely allowlisted, so the chain stays prompt-required. If THIS skill stops prompting, check the user's `~/.claude/settings.json` for a `Bash(pwd*)` or `Bash(sleep *)` rule before suspecting a Hot Sheet regression.

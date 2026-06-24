---
name: test-permission-short-run
description: Trigger a permission prompt for a short Bash command (a single tiny invocation), useful for testing the minimal Bash-tool permission UI.
---

Trigger a Bash-tool permission prompt for a SHORT command.

Run exactly:

```bash
pwd
```

Use `description: "Short-run permission test"`. Don't add flags, redirects, pipes, or chained commands — keep it as small as possible.

**Why `pwd` and not `echo hi`?** Most users have `Bash(echo *)` in their Claude Code allow-list (`~/.claude/settings.json`); when an allow-rule matches, Claude Code skips the permission prompt entirely so Hot Sheet never sees one to surface. `pwd` is rarely allowlisted and almost always triggers the prompt. If THIS skill stops prompting too, check the user's `~/.claude/settings.json` for a `Bash(pwd*)` rule before suspecting a Hot Sheet regression.

---
name: test-permission-yes-no
description: Trigger an AskUserQuestion prompt with a binary yes/no choice, useful for testing the simplest two-option question UI.
---

Trigger a binary AskUserQuestion prompt.

Call AskUserQuestion with exactly one question:

- `question`: `Test prompt: do you want to proceed?`
- `header`: `Proceed?`
- `multiSelect`: `false`
- `options`:
  1. `label`: `Yes`, `description`: `Confirm and continue with the test action.`
  2. `label`: `No`, `description`: `Cancel — do not perform the test action.`

After the user answers, just echo back which option they chose. Don't perform any other tool calls.

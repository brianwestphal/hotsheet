---
name: test-permission-multiple-choice
description: Trigger an AskUserQuestion prompt with four single-select options, useful for testing multi-option question rendering.
---

Trigger a four-option AskUserQuestion prompt.

Call AskUserQuestion with exactly one question:

- `question`: `Test prompt: which option do you want to pick?`
- `header`: `Pick one`
- `multiSelect`: `false`
- `options`:
  1. `label`: `Option A`, `description`: `The first option — selecting it should be fast and uneventful.`
  2. `label`: `Option B`, `description`: `The second option — a slightly different path with similar shape.`
  3. `label`: `Option C`, `description`: `The third option — useful if you want to test a longer description that wraps onto multiple lines so we see how the prompt renders verbose option text.`
  4. `label`: `Option D`, `description`: `The fourth option — final fallback choice.`

After the user answers, echo back the chosen label. No other tool calls.

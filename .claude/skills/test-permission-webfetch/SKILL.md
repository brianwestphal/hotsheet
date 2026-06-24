---
name: test-permission-webfetch
description: Trigger a permission prompt for the WebFetch tool against a known-safe URL.
---

Trigger a WebFetch permission prompt.

Call WebFetch with:

- `url`: `https://example.com/`
- `prompt`: `Summarize the page in one sentence — this call exists only to surface the WebFetch permission prompt.`

After it returns, just relay the one-sentence summary to the user.

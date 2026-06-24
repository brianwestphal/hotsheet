---
name: test-permission-long-run
description: Trigger a permission prompt for a long Bash command (multi-line, many flags), useful for testing how the Bash-tool permission UI renders big commands.
---

Trigger a Bash-tool permission prompt for a LONG command.

Run this exact command via the Bash tool. Do not split it into multiple calls and do not shorten it — the goal is to see the prompt render a long invocation:

```bash
mkdir -p /tmp/claude-permission-test && cd /tmp/claude-permission-test && printf 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n' > long-run-input.txt && cat long-run-input.txt | awk '{ print NR": "$0" — annotated by the long-run permission test" }' | sort -r | tee long-run-output.txt | wc -l && echo "long-run permission test finished at $(date -u +%Y-%m-%dT%H:%M:%SZ) with input checksum $(shasum -a 256 long-run-input.txt | awk '{print $1}') and output checksum $(shasum -a 256 long-run-output.txt | awk '{print $1}')"
```

Use `description: "Long-run permission test: seed file, transform, checksum"` so the prompt also exercises the description field.

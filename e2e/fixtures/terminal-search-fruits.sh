#!/bin/bash
# HS-7363 fixture: prints a known multi-line output with three occurrences of
# "apple" so the terminal-search e2e can assert a deterministic match count,
# then sleeps so the PTY stays alive while the spec drives the search widget.
printf 'apple\nbanana\napple\napple\n'
exec sleep 3600

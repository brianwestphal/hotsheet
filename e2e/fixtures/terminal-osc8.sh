#!/bin/bash
# HS-7274 e2e fixture — emits an OSC 8 hyperlink-wrapped text chunk followed by
# a bare plain URL on its own line. Both should route external-click activation
# through the Tauri `open_url` command. Writes its output in small chunks and
# then idles so the test has a stable, complete drawer xterm to click in.
#
# OSC 8 syntax: ESC ] 8 ; params ; URI ST text ESC ] 8 ; ; ST
#   - `\e]8;;URI\e\\` opens the hyperlink with empty params
#   - `\e]8;;\e\\` closes it
#
# HYPERLINK_URL / PLAIN_URL env vars let the test parameterise which URL each
# side targets so the test can assert the exact value that reached invoke().

HYPERLINK_URL="${HYPERLINK_URL:-https://osc8-link.example.com/hello}"
PLAIN_URL="${PLAIN_URL:-https://plain-url.example.com/world}"

printf '\e]8;;%s\e\\CLICK-OSC8-LINK\e]8;;\e\\\n' "$HYPERLINK_URL"
printf '%s\n' "$PLAIN_URL"
printf 'READY\n'

# Keep the PTY alive so the drawer stays mounted for the test.
while true; do
  read -t 1 -r _ 2>/dev/null || true
done

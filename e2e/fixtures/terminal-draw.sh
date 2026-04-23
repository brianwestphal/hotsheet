#!/bin/bash
# HS-7097 e2e fixture — draws a recognizable "top bar" at row 1 and a
# "bottom keybar" at the last row (using the current terminal height),
# matching the shape of a full-screen TUI like nano. Redraws on SIGWINCH
# so the e2e test can observe whether a later resize (triggered by the
# dashboard tile's attach) actually reaches the PTY and causes the
# content to re-fill the new geometry.

redraw() {
  local rows cols
  rows=$(tput lines 2>/dev/null || echo 24)
  cols=$(tput cols 2>/dev/null || echo 80)
  # Clear + home.
  printf '\033[2J\033[H'
  # Top row: inverse-video "TOP-STATUS-BAR" marker.
  printf '\033[1;1H\033[7m TOP-STATUS-BAR (rows=%s cols=%s) \033[m' "$rows" "$cols"
  # Bottom row: inverse-video "BOTTOM-KEYBAR" marker at the last row.
  printf '\033[%d;1H\033[7m BOTTOM-KEYBAR \033[m' "$rows"
}

trap 'redraw' WINCH
redraw

# Keep the shell alive; `read -t` is signal-interruptible so SIGWINCH
# actually wakes the process and runs the trap.
while true; do
  read -t 1 -r _ 2>/dev/null || true
done

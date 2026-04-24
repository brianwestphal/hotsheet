#!/bin/bash
# HS-7273 e2e fixture — emits OSC 9 desktop-notification escapes on demand.
# Mode is picked via the MODE env var so one fixture covers every e2e case.
#
#   MODE=simple    — prints one OSC 9 BEL-terminated notification ($MESSAGE),
#                    then idles. Default message is "Build done".
#   MODE=dedupe    — prints the SAME message twice in quick succession so the
#                    test can assert only one toast shows (recentlyToasted
#                    cache in bellPoll.tsx dedupes).
#   MODE=sequence  — prints two DIFFERENT messages in quick succession so the
#                    test can assert two distinct toasts fire ($MSG1, $MSG2).
#   MODE=progress  — prints an iTerm2 OSC 9;4 progress subcommand; the
#                    scanner parks these so NO toast / bell should fire.
#
# All modes end with a printed READY marker so the test has a stable anchor
# to synchronize on before asserting.

MODE="${MODE:-simple}"

case "$MODE" in
  simple)
    printf '\e]9;%s\a' "${MESSAGE:-Build done}"
    ;;
  dedupe)
    printf '\e]9;%s\a' "${MESSAGE:-Same message}"
    sleep 0.05
    printf '\e]9;%s\a' "${MESSAGE:-Same message}"
    ;;
  sequence)
    printf '\e]9;%s\a' "${MSG1:-Stage 1}"
    sleep 0.05
    printf '\e]9;%s\a' "${MSG2:-Stage 2}"
    ;;
  progress)
    # iTerm2 progress subcommand: 9;4;state;progress (state=3 indeterminate, 50%)
    printf '\e]9;4;3;50\a'
    ;;
  *)
    printf 'unknown MODE=%s\n' "$MODE" >&2
    ;;
esac

printf 'READY\n'

# Keep the PTY alive.
while true; do
  read -t 1 -r _ 2>/dev/null || true
done

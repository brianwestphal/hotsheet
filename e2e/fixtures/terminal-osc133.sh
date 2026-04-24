#!/bin/bash
# HS-7327 / HS-7328 / HS-7332 e2e fixture — emits OSC 133 prompt/command/output
# /end marks per docs/26-shell-integration-osc133.md so the client side picks
# up the same shell-integration state a real shell-rc snippet would produce.
# Mode is picked via the MODE env var so one fixture covers every Phase
# 1b / 2 / 3 e2e case.
#
#   MODE=output     — emits ONE complete prompt cycle (A → B → C → output → D;0)
#                     using $OUTPUT (default "Hello from OSC 133") as the body,
#                     then idles. Used by HS-7327 to assert copy-last-output
#                     reads the right range.
#   MODE=multi      — emits THREE complete prompt cycles separated by short
#                     idles. Each cycle emits A → B → C → output → D;0 with
#                     incrementing output bodies. Used by HS-7328 to assert
#                     Cmd/Ctrl+Up/Down jumps walk between prompt markers and
#                     the hover popover materialises on each glyph.
#   MODE=fail       — emits ONE prompt cycle whose D mark carries a non-zero
#                     exit code so the client renders a red-X gutter glyph and
#                     the popover surfaces the Ask Claude button. Used by
#                     HS-7332.
#   MODE=none       — emits NO OSC 133 escapes at all (just a READY marker and
#                     idle). Used to assert the copy-output toolbar button
#                     stays hidden when shell integration never engages.
#
# All modes end with a printed READY\n marker so the test has a stable anchor
# to wait for in `.xterm-screen` before driving any assertion.

MODE="${MODE:-output}"
OUTPUT="${OUTPUT:-Hello from OSC 133}"
EXIT_CODE="${EXIT_CODE:-0}"

emit_prompt_start() { printf '\e]133;A\a'; }
emit_command_start() { printf '\e]133;B\a'; }
emit_output_start() { printf '\e]133;C\a'; }
emit_command_end() { printf '\e]133;D;%s\a' "$1"; }

case "$MODE" in
  output)
    emit_prompt_start
    printf '$ '
    emit_command_start
    printf 'echo "%s"\n' "$OUTPUT"
    emit_output_start
    printf '%s\n' "$OUTPUT"
    emit_command_end "$EXIT_CODE"
    ;;
  multi)
    for i in 1 2 3; do
      emit_prompt_start
      printf '$ '
      emit_command_start
      printf 'echo "line %d"\n' "$i"
      emit_output_start
      printf 'OUTPUT-%d\n' "$i"
      emit_command_end 0
      sleep 0.05
    done
    ;;
  fail)
    emit_prompt_start
    printf '$ '
    emit_command_start
    printf 'false\n'
    emit_output_start
    printf '%s\n' "$OUTPUT"
    emit_command_end "${EXIT_CODE:-1}"
    ;;
  none)
    printf 'no shell integration here\n'
    ;;
  *)
    printf 'unknown MODE=%s\n' "$MODE" >&2
    ;;
esac

printf 'READY\n'

# Keep the PTY alive so the xterm has something to attach to for the full test.
while true; do
  read -t 1 -r _ 2>/dev/null || true
done

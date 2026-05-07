#!/bin/bash
# HS-8287 e2e fixture — emits the marker (passed via $1) once, then sleeps
# forever so the PTY stays alive through a forced WS disconnect/reconnect
# cycle without any further output. The marker count stays at 1 in the
# server's ring buffer for the duration of the test, so the post-reconnect
# count assertion is unambiguous.
echo "$1"
exec sleep 600

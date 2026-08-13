#!/usr/bin/env python3
"""HS-7097 e2e fixture — draws a TOP marker at row 1 and a BOTTOM marker at
the current last row of the controlling terminal, redrawing on SIGWINCH so
the e2e test can observe whether a resize from the client side actually
reaches the PTY and causes the content to re-fill the new geometry.

Python is used (instead of a bash WINCH trap) because Python's signal
module reliably runs the handler even when the main thread is blocked on
`signal.pause()` — bash 3.2's WINCH trap with `read -t N` was racy on
macOS and the trap fired only intermittently, masking whether the resize
was reaching the PTY at all.
"""
import fcntl
import os
import signal
import struct
import sys
import termios


def get_size() -> tuple[int, int]:
    fd = sys.stdout.fileno()
    packed = struct.pack('HHHH', 0, 0, 0, 0)
    rows, cols, _, _ = struct.unpack('HHHH', fcntl.ioctl(fd, termios.TIOCGWINSZ, packed))
    return rows, cols


def redraw(*_args: object) -> None:
    # `redraw` is BOTH the SIGWINCH handler and the initial draw, so a resize
    # that arrives mid-draw re-enters this function. `sys.stdout` is a buffered
    # writer whose write/flush raise `RuntimeError: reentrant call inside
    # <_io.BufferedWriter>` when re-entered from a signal handler — which crashed
    # the fixture intermittently and made the terminal show a Python traceback
    # instead of the markers the tests assert on. Emit the whole frame with a
    # single raw `os.write()` syscall: it bypasses the buffered writer (no
    # reentrancy guard to trip) and auto-retries on EINTR (PEP 475).
    rows, cols = get_size()
    frame = (
        '\033[2J\033[H'
        f'\033[1;1H\033[7m TOP-STATUS-BAR (rows={rows} cols={cols}) \033[m'
        f'\033[{rows};1H\033[7m BOTTOM-KEYBAR \033[m'
    )
    os.write(sys.stdout.fileno(), frame.encode())


def main() -> None:
    signal.signal(signal.SIGWINCH, redraw)
    redraw()
    # signal.pause() returns whenever any signal is delivered, including
    # SIGWINCH. The handler runs first, then pause() returns and we loop
    # back to wait for the next one.
    while True:
        signal.pause()


if __name__ == '__main__':
    main()

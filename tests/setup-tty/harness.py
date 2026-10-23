"""Runs a command on a pseudo-terminal and drives it as a person at a terminal would.

Usage: python3 harness.py <spec.json>

The spec is a JSON object:
  argv     the command and its arguments
  env      its environment
  cwd      its working directory
  result   where to write the result (JSON)
  events   where to append each event as it happens, one JSON line each (so the caller can act
           while the command runs)
  steps    what to do, in order, each one of:
    {"read_until": <text>, "timeout": <s>}  read the terminal until <text> appears (ANSI removed)
    {"read_for": <s>}                       read the terminal for <s> seconds
    {"pause": <s>}                          stop reading the terminal for <s> seconds
    {"send": <text>}                        type <text> (such as "\u0003", Ctrl-C)
    {"signal": "TERM"}                      send the command a signal
    {"wait_exit": <s>}                      read until the command exits, for up to <s> seconds
    {"kill": true}                          SIGKILL the command

The result: {"exit_code", "signal", "output" (everything read, ANSI removed), "timed_out"}.
"""

import errno
import fcntl
import json
import os
import pty
import re
import select
import signal
import struct
import sys
import termios
import time

ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")


def main() -> None:
    with open(sys.argv[1], encoding="utf-8") as handle:
        spec = json.load(handle)

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(spec["cwd"])
        os.execve(spec["argv"][0], spec["argv"], spec["env"])

    # A terminal 120 columns wide, as a person's would be.
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))

    raw = bytearray()
    status = None
    timed_out = []

    def event(name: str, **fields) -> None:
        with open(spec["events"], "a", encoding="utf-8") as handle:
            handle.write(json.dumps({"event": name, "at": time.time(), **fields}) + "\n")

    def text() -> str:
        return ANSI.sub("", raw.decode("utf-8", errors="replace"))

    def reap() -> None:
        nonlocal status
        if status is not None:
            return
        done, code = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            status = code

    def read(seconds: float, until=None) -> bool:
        """Reads for up to `seconds`; True once `until` holds."""
        deadline = time.time() + seconds
        while True:
            if until is not None and until():
                return True
            left = deadline - time.time()
            if left <= 0:
                return False
            ready, _, _ = select.select([fd], [], [], min(left, 0.05))
            if ready:
                try:
                    chunk = os.read(fd, 65536)
                except OSError as error:
                    if error.errno != errno.EIO:
                        raise
                    chunk = b""
                if not chunk:
                    reap()
                    if status is not None:
                        return until() if until is not None else False
                    time.sleep(0.05)
                raw.extend(chunk)
            else:
                reap()

    event("started", pid=pid)
    for step in spec["steps"]:
        if "read_until" in step:
            wanted = step["read_until"]
            if not read(step.get("timeout", 30), lambda: wanted in text()):
                timed_out.append(wanted)
                break
            event("seen", text=wanted)
        elif "read_for" in step:
            read(step["read_for"])
        elif "pause" in step:
            event("pause-start")
            time.sleep(step["pause"])
            event("pause-end")
        elif "send" in step:
            os.write(fd, step["send"].encode("utf-8"))
            event("sent")
        elif "signal" in step:
            os.kill(pid, getattr(signal, "SIG" + step["signal"]))
            event("signalled", signal=step["signal"])
        elif "wait_exit" in step:

            def exited() -> bool:
                reap()
                return status is not None

            if not read(step["wait_exit"], exited):
                timed_out.append("exit")
                break
        elif step.get("kill"):
            reap()
            if status is None:
                os.kill(pid, signal.SIGKILL)

    reap()
    if status is None:
        os.kill(pid, signal.SIGKILL)
        _, status = os.waitpid(pid, 0)
    # Whatever is still buffered.
    read(0.2)

    result = {
        "exit_code": os.WEXITSTATUS(status) if os.WIFEXITED(status) else None,
        "signal": os.WTERMSIG(status) if os.WIFSIGNALED(status) else None,
        "output": text(),
        "timed_out": timed_out,
    }
    with open(spec["result"], "w", encoding="utf-8") as handle:
        json.dump(result, handle)


if __name__ == "__main__":
    main()

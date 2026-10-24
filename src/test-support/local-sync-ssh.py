"""Test-only SSH process stand-in: run real shell commands, relay binary streams.

There is no network, key or VM. All paths and subprocess cwd/env are supplied by
local-sync-ssh.ts under the test's scratch directory. Gates stop a real transfer
mid-stream; archive injection models an untrusted sandbox's outbound bytes.
"""
import gzip
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import threading
import time

config = json.loads(Path(sys.argv[1]).read_text())
child = subprocess.Popen(
    ["/bin/sh", "-c", config["command"]],
    cwd=config["root"],
    env={**os.environ, "HOME": config["root"], "TMPDIR": config["root"], "LC_ALL": "C"},
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    start_new_session=True,
)
interrupted = threading.Event()
errors = []
checkpointed = set()


def terminate(signum=signal.SIGTERM, _frame=None):
    interrupted.set()
    try:
        os.killpg(child.pid, signum)
    except ProcessLookupError:
        pass


signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)


def checkpoint(direction, count):
    gate = config.get("gate")
    if not gate or gate["direction"] != direction or count < gate["afterBytes"] or direction in checkpointed:
        return
    checkpointed.add(direction)
    marker = Path(gate["reached"])
    if marker.exists():
        return
    # Existence is the reader's gate: publish only after the complete count.
    pending = marker.with_name(marker.name + '.publishing.' + str(os.getpid()))
    try:
        pending.write_text(str(count))
        os.replace(pending, marker)
    finally:
        pending.unlink(missing_ok=True)
    deadline = time.monotonic() + 12
    while not Path(gate["release"]).exists():
        if interrupted.is_set():
            return
        if time.monotonic() > deadline:
            errors.append("test transfer gate was never released")
            terminate(signal.SIGKILL)
            return
        time.sleep(0.005)
    if gate.get("interrupt"):
        terminate(signal.SIGKILL)


def inbound():
    count = 0
    try:
        while not interrupted.is_set():
            chunk = os.read(sys.stdin.fileno(), 4096)
            if not chunk:
                break
            child.stdin.write(chunk)
            child.stdin.flush()
            count += len(chunk)
            checkpoint("in", count)
    except (BrokenPipeError, OSError):
        pass
    finally:
        try:
            child.stdin.close()
        except (BrokenPipeError, OSError):
            pass


def outbound():
    count = 0
    first = True
    injected = False
    try:
        while not interrupted.is_set():
            # Buffered read fills the first header unless the process hits EOF.
            chunk = child.stdout.read(4096)
            if not chunk:
                break
            if first and config.get("archiveOverride"):
                first = False
                is_gzip = chunk.startswith(b"\x1f\x8b")
                is_tar = len(chunk) >= 512 and chunk[257:262] == b"ustar"
                if is_gzip or is_tar:
                    body = Path(config["archiveOverride"]).read_bytes()
                    Path(config["archiveInjected"]).write_text("yes")
                    sys.stdout.buffer.write(gzip.compress(body) if is_gzip else body)
                    sys.stdout.buffer.flush()
                    injected = True
            if injected:
                continue  # drain the real producer, but never forward its bytes
            sys.stdout.buffer.write(chunk)
            sys.stdout.buffer.flush()
            count += len(chunk)
            checkpoint("out", count)
    except (BrokenPipeError, OSError):
        terminate(signal.SIGKILL)


def stderr():
    try:
        while True:
            chunk = os.read(child.stderr.fileno(), 4096)
            if not chunk:
                break
            sys.stderr.buffer.write(chunk)
            sys.stderr.buffer.flush()
    except (BrokenPipeError, OSError):
        pass


threads = [threading.Thread(target=fn, daemon=True) for fn in (inbound, outbound, stderr)]
for thread in threads:
    thread.start()
code = child.wait()
# stdin can remain open after a failed receiver; it must not prevent exit.
for thread in threads[1:]:
    thread.join(timeout=15)
if errors:
    sys.stderr.write("\n".join(errors) + "\n")
if interrupted.is_set():
    sys.stderr.write("local SSH stand-in: interrupted transport\n")
    sys.exit(74)
sys.exit(config.get("exitCode") or (code if code >= 0 else 128 - code))

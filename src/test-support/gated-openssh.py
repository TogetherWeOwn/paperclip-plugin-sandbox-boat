"""Test-only delivery/startup gate around REAL multiplexed OpenSSH.

The relay may die locally; its independent worker still represents a command
already submitted to the transport. NO local signal is forwarded to SSH or to
any remote process. Only production remote cancellation can satisfy the tests.
All workers, SSH clients, payloads and files are registered for owned teardown.
"""
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time

root = Path(sys.argv[2])
mode = sys.argv[3]
command = sys.argv[4:]


def publish(name, value):
    temporary = root / (name + '.tmp')
    temporary.write_text(value)
    temporary.replace(root / name)


def stamp(name):
    # Include Linux start time so teardown cannot kill a recycled PID.
    stat = Path('/proc/self/stat').read_text().rsplit(')', 1)[1].split()
    publish(name, json.dumps({'pid': os.getpid(), 'start': stat[19]}))


if sys.argv[1] == 'worker':
    stamp('worker.json')
    if mode == 'startup':
        (root / 'startup-held').write_text('held')
        while not (root / 'startup-release').exists():
            time.sleep(.005)
    with (root / 'stdout').open('wb') as out, (root / 'stderr').open('wb') as err:
        child = subprocess.Popen(command, stdin=subprocess.DEVNULL, stdout=out, stderr=err)
        (root / 'ssh.pid').write_text(str(child.pid))
        code = child.wait()
    publish('exit.json', json.dumps(code))
    raise SystemExit(code if code >= 0 else 128 - code)

# Separate process group, no inherited pipes keeping runStream artificially
# alive. The worker is killed ONLY by test teardown, not by the local relay.
subprocess.Popen([sys.executable, __file__, 'worker', str(root), mode, *command],
                 start_new_session=True, stdin=subprocess.DEVNULL,
                 stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, close_fds=True)
signal.signal(signal.SIGTERM, lambda sig, frame: sys.exit(128 + sig))
signal.signal(signal.SIGINT, lambda sig, frame: sys.exit(128 + sig))
offsets = {'stdout': 0, 'stderr': 0}
while True:
    done = (root / 'exit.json').exists()
    for name, stream in [('stdout', sys.stdout.buffer), ('stderr', sys.stderr.buffer)]:
        file = root / name
        if not file.exists():
            continue
        if name == 'stderr' and mode == 'marker' and not (root / 'marker-release').exists():
            if file.stat().st_size:
                (root / 'stderr-held').write_text('held')
            continue
        with file.open('rb') as source:
            source.seek(offsets[name])
            data = source.read()
        if data:
            stream.write(data)
            stream.flush()
            offsets[name] += len(data)
            (root / (name + '-delivered')).write_text(str(offsets[name]))
    if done:
        code = json.loads((root / 'exit.json').read_text())
        raise SystemExit(code if code >= 0 else 128 - code)
    time.sleep(.005)

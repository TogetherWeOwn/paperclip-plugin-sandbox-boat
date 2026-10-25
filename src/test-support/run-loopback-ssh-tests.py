"""Run real loopback-SSH tests without installing packages or host services.

Usage: python3 src/test-support/run-loopback-ssh-tests.py [vitest run arguments | --check]
--check runs the repository's full npm check under the same reaping boundary.
Requires node_modules and PAPERCLIP_RUN_SCRATCH_DIR (or PAPERCLIP_SCRATCH_DIR).
On Debian, absent sshd is obtained with apt-get download + dpkg-deb -x ONLY.
No sudo, package scripts, service management, real keys, Boat calls or VM spend.
"""
import ctypes
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import tempfile
import time

# Keep detached test grandchildren inside this run's reaping boundary. Killing
# owned process groups in fixture teardown must not leave orphan zombies under
# an ambient container init. This changes no signal delivery during assertions.
PR_SET_CHILD_SUBREAPER = 36
if sys.platform != 'linux' or ctypes.CDLL(None, use_errno=True).prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) != 0:
    raise SystemExit('Linux child-subreaper prerequisite unavailable for owned SSH teardown.')


def reap_adopted_children(test_pid):
    reaped = 0
    for child in Path(f'/proc/self/task/{os.getpid()}/children').read_text().split():
        pid = int(child)
        if pid == test_pid:
            continue  # subprocess.Popen alone owns the test runner's wait status.
        try:
            if os.waitpid(pid, os.WNOHANG)[0]:
                reaped += 1
        except ChildProcessError:
            pass
    return reaped


def reap_owned_children(reaped):
    deadline = time.monotonic() + 5
    while True:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            print(f'Owned SSH teardown: reaped {reaped} adopted children; no children remain.', flush=True)
            return
        if pid:
            reaped += 1
            continue
        if time.monotonic() >= deadline:
            break
        time.sleep(.01)
    # Fail closed, but still clean up ONLY direct children adopted by this
    # subreaper. Never signal an ambient runner/sshd or another test run.
    for _ in range(500):
        children = Path(f'/proc/self/task/{os.getpid()}/children').read_text().split()
        if not children:
            break
        for child in children:
            try:
                os.kill(int(child), signal.SIGKILL)
            except ProcessLookupError:
                pass
        while True:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if not pid:
                break
        time.sleep(.01)
    raise RuntimeError('SSH fixture teardown left running adopted children; killed/reaped run-owned leftovers.')

repo = Path(__file__).resolve().parents[2]
scratch = os.environ.get('PAPERCLIP_RUN_SCRATCH_DIR') or os.environ.get('PAPERCLIP_SCRATCH_DIR')
if not scratch:
    raise SystemExit('Set PAPERCLIP_RUN_SCRATCH_DIR to confined test scratch.')
env = dict(os.environ)
with tempfile.TemporaryDirectory(prefix='loopback-prerequisites-', dir=scratch) as temporary:
    root = Path(temporary)
    if not env.get('PAPERCLIP_TEST_SSHD'):
        installed = shutil.which('sshd')
        if not installed and Path('/usr/sbin/sshd').is_file():
            installed = '/usr/sbin/sshd'
        if installed:
            env['PAPERCLIP_TEST_SSHD'] = installed
        else:
            packages = ['openssh-server', 'libwrap0', 'libwtmpdb0']
            subprocess.run(['apt-get', 'download', *packages], cwd=root, check=True)
            extracted = root / 'extracted'
            for package in root.glob('*.deb'):
                subprocess.run(['dpkg-deb', '-x', str(package), str(extracted)], check=True)
            env['PAPERCLIP_TEST_SSHD'] = str(extracted / 'usr/sbin/sshd')
            env['PAPERCLIP_TEST_SSHD_LIBEXEC'] = str(extracted / 'usr/lib/openssh')
            libraries = [str(directory) for directory in (extracted / 'usr/lib').iterdir()
                         if directory.is_dir() and any(directory.glob('*.so*'))]
            env['LD_LIBRARY_PATH'] = ':'.join(libraries + ([env['LD_LIBRARY_PATH']] if env.get('LD_LIBRARY_PATH') else []))
    args = sys.argv[1:] or ['src/native-sync-multiplexed-ssh.test.ts', '--reporter=verbose']
    command = ['npm', 'run', 'check'] if args == ['--check'] else [str(repo / 'node_modules/.bin/vitest'), 'run', *args]
    reaped = 0
    try:
        result = subprocess.Popen(command, cwd=repo, env=env)
        while result.poll() is None:
            # Reap DURING assertions too: keeping dead adopted group members as
            # zombies would artificially delay production kill(group, 0) loops.
            # This never sends a signal or terminates any live payload.
            reaped += reap_adopted_children(result.pid)
            time.sleep(.01)
    finally:
        reap_owned_children(reaped)
    raise SystemExit(result.returncode)

"""Run real loopback-SSH tests without installing packages or host services.

Usage: python3 src/test-support/run-loopback-ssh-tests.py [vitest run arguments]
Requires node_modules and PAPERCLIP_RUN_SCRATCH_DIR (or PAPERCLIP_SCRATCH_DIR).
On Debian, absent sshd is obtained with apt-get download + dpkg-deb -x ONLY.
No sudo, package scripts, service management, real keys, Boat calls or VM spend.
"""
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

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
    result = subprocess.run([str(repo / 'node_modules/.bin/vitest'), 'run', *args], cwd=repo, env=env)
    raise SystemExit(result.returncode)

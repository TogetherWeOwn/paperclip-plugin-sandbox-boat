// Linux guest-side lifecycle, transported through the existing pinned SSH path.
// The detached supervisor/watchdog stays OUTSIDE the command cgroup. State and
// output are private, bounded and ephemeral (/tmp, never a Boat snapshot).
export const OFFLOAD_SSH_SCRIPT = String.raw`
import base64, fcntl, json, os, pathlib, secrets, selectors, signal, stat, subprocess, sys, time

MAX_OUTPUT = 1048576
BOOT = pathlib.Path('/proc/sys/kernel/random/boot_id').read_text().strip()
OWNERSHIP = ('guestBootId', 'processGroupId', 'cgroupPath', 'journalGeneration')


def canonical(value):
    if not isinstance(value, str) or not value.startswith('/') or any(p in ('', '.', '..') for p in value.split('/')[1:]):
        raise ValueError('noncanonical guest path')
    if os.path.realpath(value) != value:
        raise ValueError('symlinked guest path')
    return value


def start_time(pid):
    try:
        fields = pathlib.Path('/proc/' + str(pid) + '/stat').read_text().rsplit(')', 1)[1].split()
        return None if fields[0] in ('Z', 'X') else fields[19]
    except FileNotFoundError:
        return None


def save(root, value):
    temporary = root / ('write-' + secrets.token_hex(8))
    with temporary.open('x') as output:
        json.dump(value, output)
        output.flush()
        os.fsync(output.fileno())
    os.replace(temporary, root / 'state')


def load(root):
    filename = root / 'state'
    fd = os.open(filename, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd) as source:
        info = os.fstat(source.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > 131072:
            raise ValueError('unsafe guest state')
        return json.load(source)


def locked(root):
    fd = os.open(root / 'lock', os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK)
    info = os.fstat(fd)
    if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        os.close(fd)
        raise ValueError('unsafe guest lock')
    deadline = time.monotonic() + 2
    while True:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            return os.fdopen(fd, 'r+')
        except BlockingIOError:
            if time.monotonic() >= deadline:
                os.close(fd)
                raise RuntimeError('guest lock timeout')
            time.sleep(.01)


def subtree(identity):
    group = pathlib.Path(canonical(identity['cgroupPath']))
    if not str(group).startswith('/sys/fs/cgroup/') or not group.name.startswith('paperclip-boat-'):
        raise ValueError('not an owned command cgroup')
    return group


def populated(identity):
    return 'populated 1' in (subtree(identity) / 'cgroup.events').read_text()


def outside_command(identity, pid):
    membership = pathlib.Path('/proc/' + str(pid) + '/cgroup').read_text().split('0::', 1)[1].strip()
    owned = identity['cgroupPath'].removeprefix('/sys/fs/cgroup')
    return membership != owned and not membership.startswith(owned + '/')


def validate(root, actual):
    canonical(str(root))
    info = root.stat()
    if info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise ValueError('unsafe guest state directory')
    value = load(root)
    expected = value['identity']
    if actual.get('guestBootId') != BOOT or any(actual.get(k) != expected[k] for k in OWNERSHIP):
        raise ValueError('guest ownership changed')
    group = subtree(expected)
    if group.stat().st_ino != value['cgroupInode']:
        raise ValueError('guest cgroup replaced')
    current = start_time(expected['processGroupId'])
    if current is not None and current != value['processStart']:
        raise ValueError('guest process identity changed')
    return value


def terminate(identity, hard=False):
    group = subtree(identity)
    if hard:
        (group / 'cgroup.kill').write_text('1')
    else:
        # TERM every process in the subtree, including setsid descendants. KILL
        # uses the kernel's recursive cgroup.kill after the host grace period.
        for directory, _, _ in os.walk(group):
            for pid in (pathlib.Path(directory) / 'cgroup.procs').read_text().split():
                try:
                    os.kill(int(pid), signal.SIGTERM)
                except ProcessLookupError:
                    pass


def prepare(data):
    parent = pathlib.Path(canonical(data['cgroupParent']))
    if not str(parent).startswith('/sys/fs/cgroup/') or not (parent / 'cgroup.controllers').is_file():
        raise ValueError('cgroup v2 delegation required')
    group = parent / ('paperclip-boat-' + secrets.token_hex(16))
    group.mkdir()
    root = pathlib.Path(canonical(data['stateRoot'])) / group.name
    try:
        root.mkdir(mode=0o700)
        (root / 'lock').touch(mode=0o600, exist_ok=False)
        (root / 'program.py').write_text(data.pop('program'))
        data['cgroupPath'] = str(group)
        save(root, {'request': data})
        subprocess.Popen([sys.executable, '-I', str(root / 'program.py'), 'supervise', str(root)],
                         start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         env={'PATH': os.defpath, 'HOME': os.environ.get('HOME', '/tmp')})
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            value = load(root)
            if 'identity' in value and value.get('watchdogPid'):
                return value['identity']
            time.sleep(.01)
        raise RuntimeError('guest supervisor did not prepare')
    except BaseException:
        (group / 'cgroup.kill').write_text('1')
        raise


def supervise(root):
    request = load(root)['request']
    group = pathlib.Path(request['cgroupPath'])
    read_gate, write_gate = os.pipe()
    # The child enters its cgroup BEFORE it can receive the one-use exec gate.
    gate = "import os,sys; fd=int(sys.argv[1]); admitted=os.read(fd,1); os.close(fd); sys.exit(125) if admitted != b'1' else os.execvpe(sys.argv[2],sys.argv[2:],os.environ)"
    def join():
        (group / 'cgroup.procs').write_text(str(os.getpid()))
    environment = {'PATH': request['path'], 'HOME': os.environ.get('HOME', '/tmp'), **request['env']}
    child = subprocess.Popen([sys.executable, '-I', '-c', gate, str(read_gate), request['executable'], *request['args']],
        cwd=canonical(request['cwd']), env=environment, pass_fds=(read_gate,), start_new_session=True,
        preexec_fn=join, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    os.close(read_gate)
    now = int(time.time() * 1000)
    identity = {**request['base'], 'guestBootId': BOOT, 'processGroupId': child.pid,
                'cgroupPath': str(group), 'journalGeneration': 1, 'heartbeatDeadline': now + 30000,
                'guestDeadline': now + request['timeoutMs']}
    value = {'identity': identity, 'cgroupInode': group.stat().st_ino, 'processStart': start_time(child.pid),
             'supervisorPid': os.getpid(), 'supervisorStart': start_time(os.getpid()),
             'armed': False, 'started': False, 'startRequested': False, 'result': None}
    save(root, value)
    watcher = subprocess.Popen([sys.executable, '-I', str(root / 'program.py'), 'watch', str(root)],
        start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with locked(root):
        value = load(root)
        value['watchdogPid'] = watcher.pid
        value['watchdogStart'] = start_time(watcher.pid)
        save(root, value)
    selector = selectors.DefaultSelector()
    for stream, pipe in (('stdout', child.stdout), ('stderr', child.stderr)):
        os.set_blocking(pipe.fileno(), False)
        selector.register(pipe, selectors.EVENT_READ, stream)
    bytes_written = 0
    started = time.monotonic()
    fixed_deadline = started + request['timeoutMs'] / 1000
    cancelled = False
    overflow = False
    with (root / 'output').open('x') as output:
        while True:
            with locked(root):
                value = load(root)
                if time.monotonic() >= fixed_deadline or int(time.time() * 1000) >= value['identity']['heartbeatDeadline']:
                    terminate(identity, True)
                    cancelled = True
                if value['startRequested'] and not value['started'] and not cancelled:
                    # Commit before releasing the exec gate. A crash is unknown,
                    # never permission for a second start.
                    value['started'] = True
                    save(root, value)
                    os.write(write_gate, b'1')
                    os.close(write_gate)
                    write_gate = None
            for key, _ in selector.select(.02):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk:
                    selector.unregister(key.fileobj)
                    key.fileobj.close()
                    continue
                bytes_written += len(chunk)
                if bytes_written > MAX_OUTPUT:
                    terminate(identity, True)
                    cancelled = True
                    overflow = True
                    continue
                output.write(json.dumps({'stream': key.data, 'dataBase64': base64.b64encode(chunk).decode()}) + '\n')
                output.flush()
            code = child.poll()
            if code is not None:
                # A background descendant can retain stdout. Do not wait for its
                # pipes before enforcing the subtree boundary.
                if populated(identity):
                    terminate(identity, True)
                if not selector.get_map():
                    break
        child.wait()
    with locked(root):
        value = load(root)
        # The independent watchdog may win while select/poll is in progress.
        # Recheck expiry at the receipt boundary instead of reporting its KILL
        # as an ordinary payload signal when the loop never iterates again.
        cancelled = cancelled or time.monotonic() >= fixed_deadline or int(time.time() * 1000) >= value['identity']['heartbeatDeadline']
        value['outputLimitExceeded'] = overflow
        value['result'] = {'exitCode': 124 if cancelled else code if code >= 0 else 128 - code,
                           'seconds': max(0, time.monotonic() - started)}
        save(root, value)
    if write_gate is not None:
        os.close(write_gate)


def watch(root):
    original = load(root)
    identity = original['identity']
    deadline = time.monotonic() + max(0, (identity['guestDeadline'] - int(time.time() * 1000)) / 1000)
    while True:
        # Independent of SSH and the supervisor. A broken state file, lost
        # supervisor or expired interest also kills this exact, unique subtree.
        try:
            value = load(root)
            if subtree(identity).stat().st_ino != original['cgroupInode']:
                return  # A delayed watchdog must never signal a replacement.
            done = value['result'] is not None and not populated(identity)
            expired = time.monotonic() >= deadline or int(time.time() * 1000) >= value['identity']['heartbeatDeadline']
            lost = start_time(original['supervisorPid']) != original['supervisorStart']
            if done:
                return
            if expired or lost:
                terminate(identity, True)
                return
        except BaseException:
            group = subtree(identity)
            if group.exists() and group.stat().st_ino == original['cgroupInode']:
                terminate(identity, True)
            return
        time.sleep(.05)


def rpc(action, data):
    if action == 'boot':
        return BOOT
    if action == 'preflight':
        parent = pathlib.Path(canonical(data['cgroupParent']))
        if not str(parent).startswith('/sys/fs/cgroup/') or not (parent / 'cgroup.controllers').is_file():
            return False
        probe = parent / ('paperclip-boat-probe-' + secrets.token_hex(8))
        try:
            probe.mkdir()
            # Actually exercise admission, recursive kill and outside placement,
            # not merely access(W_OK). No ambient process is moved or signalled.
            child = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(5)'], start_new_session=True)
            try:
                (probe / 'cgroup.procs').write_text(str(child.pid))
                outside = str(os.getpid()) not in (probe / 'cgroup.procs').read_text().split()
                (probe / 'cgroup.kill').write_text('1')
                child.wait(timeout=2)
                return outside and 'populated 0' in (probe / 'cgroup.events').read_text()
            finally:
                if child.poll() is None:
                    child.kill()
                child.wait()
        except (OSError, subprocess.TimeoutExpired):
            return False
        finally:
            if probe.exists():
                probe.rmdir()
    if action == 'prepare':
        return prepare(data)
    root = pathlib.Path(canonical(data['root']))
    if action == 'retire':
        with locked(root):
            value = validate(root, data['identity'])
            terminate(value['identity'], True)
        deadline = time.monotonic() + 3
        while populated(value['identity']) and time.monotonic() < deadline:
            time.sleep(.01)
        subtree(value['identity']).rmdir()
        return True
    with locked(root):
        value = validate(root, data['identity'])
        identity = value['identity']
        if action == 'arm':
            pid = value['watchdogPid']
            outside = outside_command(identity, pid)
            verified = start_time(pid) == value['watchdogStart'] and outside and not value['result']
            if verified:
                value['armed'] = True
                save(root, value)
            return {'verified': bool(verified), 'outsideCommandCgroup': outside}
        if action == 'heartbeat':
            deadline = data['identity']['heartbeatDeadline']
            now = int(time.time() * 1000)
            if now >= identity['heartbeatDeadline'] or deadline > now + 30000 or deadline < identity['heartbeatDeadline']:
                raise ValueError('expired or invalid interest renewal')
            identity['heartbeatDeadline'] = deadline
            save(root, value)
            return True
        if action == 'start':
            if not value['armed'] or value['startRequested'] or value['result'] or start_time(value['supervisorPid']) != value['supervisorStart'] or int(time.time() * 1000) >= min(identity['heartbeatDeadline'], identity['guestDeadline']):
                raise ValueError('guest start is fenced')
            value['startRequested'] = True
            save(root, value)
            return True
        if action in ('term', 'kill'):
            terminate(identity, action == 'kill')
            return True
        if action == 'empty':
            return not populated(identity)
        if action == 'inspect':
            return {'identity': identity, 'populated': populated(identity),
                    'receipt': 'completed' if value['result'] else 'running'}
        if action == 'read':
            events = []
            filename = root / 'output'
            if filename.exists():
                with filename.open() as output:
                    for index, line in enumerate(output):
                        if index < data['after']:
                            continue
                        if len(events) >= 4:
                            break
                        event = json.loads(line)
                        events.append(event)
            return {'events': events, 'result': value['result'] if not events else None,
                    'supervisorAlive': start_time(value['supervisorPid']) == value['supervisorStart'],
                    'outputLimitExceeded': value.get('outputLimitExceeded', False)}
        if action == 'receipt':
            if not value['started'] or not value['result'] or value.get('outputLimitExceeded') or populated(identity):
                return None
            return {'version': 1, 'kind': 'result', 'identity': identity, 'result': value['result']}
        raise ValueError('unknown guest action')


os.umask(0o077)
if sys.argv[1] == 'supervise':
    root = pathlib.Path(sys.argv[2])
    try:
        supervise(root)
    finally:
        value = load(root)
        if 'identity' in value and subtree(value['identity']).stat().st_ino == value['cgroupInode']:
            terminate(value['identity'], True)
elif sys.argv[1] == 'watch':
    watch(pathlib.Path(sys.argv[2]))
else:
    data = json.loads(sys.stdin.buffer.read(262145))
    print(json.dumps(rpc(sys.argv[1], data)), flush=True)
`;
